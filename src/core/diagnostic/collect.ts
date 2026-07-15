/**
 * Bundle data collector — pulls everything that goes into a diagnostic zip
 * and applies scrubbing. Output is a flat map `{ filename → contents }`
 * that the bundler can hand directly to fflate.
 *
 * This is the only place that knows the bundle's internal directory layout.
 * Everything is JSON or plain-text; binary files (e.g. the original
 * messages.jsonl) are re-serialised after scrubbing.
 */

import { readTextFile } from '@tauri-apps/plugin-fs';
import { appDataDir } from '@tauri-apps/api/path';
import { joinPath } from '@/utils/pathUtils';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useMCPStore, type MCPServerEntry } from '@/stores/mcpStore';
import { usePermissionStore } from '@/stores/permissionStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useDiagnosticStore } from '@/stores/diagnosticStore';
import { useScheduleStore } from '@/stores/scheduleStore';
import { skillLoader } from '@/core/skill/loader';
import { getRecentLogs, getLogDirPath } from '@/core/logging/logger';
import { APP_VERSION } from '@/utils/version';
import { platform } from '@tauri-apps/plugin-os';
import { scrubSecrets, scrubMessage } from './scrub';
import type { CheckResult, DiagnosticSnapshot, OverallStatus } from './types';

const RUNTIME_LOG_LIMIT = 200;
const DISK_LOG_TAIL_LINES = 500;

/** localStorage keys for all persisted Zustand stores. Keep in sync with storeVersions.test.ts. */
const PERSISTED_STORE_KEYS = [
  'abu-settings',
  'abu-chat',
  'abu-scratchpad-store',
  'abu-permissions',
  'abu-workspace',
  'abu-mcp-store',
  'abu-schedule',
  'abu-triggers',
  'abu-im-channel',
  'abu-projects',
  'abu-project-hint',
  'abu-diagnostic-store',
  'abu-usage-stats',
] as const;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function logFileNameForDaysBack(daysBack: number): string {
  const d = new Date(Date.now() - daysBack * 86_400_000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}.log`;
}

interface CollectOptions {
  includeRawText: boolean;
  /**
   * Conversation ID to embed (defaults to active). May be null/undefined.
   * Kept for backward compatibility — new call sites should prefer
   * {@link conversationIds}. Ignored whenever `conversationIds` was passed
   * at all (see below) — including as an empty array.
   */
  conversationId?: string | null;
  /**
   * Conversation IDs to embed (multi-select). Once this key is present in
   * `opts` at all, it fully determines the id set — including an explicit
   * empty array, which means "no conversation content" (pure
   * environment/feedback bundle). This is a legal, common case (the user
   * unchecked every conversation), not an error, and it must NOT fall back
   * to `conversationId` / the active conversation — doing so would silently
   * re-attach a conversation the user explicitly excluded. Only omitting
   * this key (`undefined`) falls back to `conversationId` / active. See
   * {@link resolveConversationIds}.
   */
  conversationIds?: string[];
  /**
   * Cap on how many (most-recent) messages to embed. A large conversation
   * (1000s of messages) serialized whole freezes the main thread during zip
   * (Bug 2). Defaults to the last {@link DEFAULT_DIAGNOSTIC_MESSAGE_CAP};
   * pass 'all' to include everything. This is a per-conversation request —
   * it is still clamped by the global {@link MAX_TOTAL_DIAGNOSTIC_MESSAGES}
   * budget shared across every selected conversation (multi-select or
   * 'all' can otherwise multiply N conversations × cap and freeze the main
   * thread all over again).
   */
  messageCap?: number | 'all';
  /** Free-text user description of the issue, written verbatim into the bundle. */
  description?: string;
  /** Screenshots to embed as binary entries under feedback/screenshots/. */
  screenshots?: { name: string; bytes: Uint8Array }[];
}

/** Default number of most-recent messages embedded per conversation. */
export const DEFAULT_DIAGNOSTIC_MESSAGE_CAP = 100;

/**
 * Global ceiling on the TOTAL number of messages embedded across every
 * selected conversation combined. `messageCap` (default or 'all') is applied
 * per-conversation, so selecting many conversations — or toggling "include
 * all messages" — can otherwise multiply N conversations × cap and freeze
 * the main thread during scrub + zip all over again (Bug 2, at the
 * multi-select aggregate level). This budget is shared across the whole
 * export and is never lifted by `messageCap: 'all'`, which only removes the
 * per-conversation limit.
 */
export const MAX_TOTAL_DIAGNOSTIC_MESSAGES = 1000;

/** Max conversations a user can attach to a feedback bundle (UI-enforced). */
export const MAX_ATTACH_CONVERSATIONS = 5;

/**
 * Resolve which conversation ids a diagnostic bundle should embed content
 * for. Once the caller passes `conversationIds` at all — including an empty
 * array — it is respected exactly as given; this is what lets a user
 * uncheck every conversation and get a pure environment/feedback bundle.
 * Falling back to `conversationId` / the active conversation only happens
 * when `conversationIds` itself was never provided (`undefined`).
 */
export function resolveConversationIds(
  opts: { conversationIds?: string[]; conversationId?: string | null },
  activeConversationId: string | null,
): string[] {
  if (opts.conversationIds !== undefined) return Array.from(new Set(opts.conversationIds));
  if (opts.conversationId) return [opts.conversationId];
  if (activeConversationId) return [activeConversationId];
  return [];
}

/**
 * Keep only the last `cap` messages (or all, when cap is 'all' or the
 * conversation is already under the cap). Pure — returns the original array
 * reference untouched when no capping is needed. Reports the true total so the
 * bundle can note that older messages were dropped (never a silent truncation).
 */
export function capDiagnosticMessages<T>(
  messages: T[],
  cap: number | 'all',
): { messages: T[]; total: number; capped: boolean } {
  const total = messages.length;
  if (cap === 'all') return { messages, total, capped: false };
  // cap <= 0 → embed no messages (diagnostic-only). Guard explicitly:
  // slice(-0) === slice(0) would otherwise return EVERYTHING.
  if (cap <= 0) return { messages: [], total, capped: total > 0 };
  if (total <= cap) return { messages, total, capped: false };
  return { messages: messages.slice(-cap), total, capped: true };
}

interface CollectResult {
  /** Map of "path inside zip" → contents. Screenshots are raw bytes; everything else is text. */
  files: Record<string, string | Uint8Array>;
  /** Aggregate scrub stat — how many text fields were redacted/replaced. */
  scrubbedTextCount: number;
}

function deriveOverall(results: CheckResult[]): OverallStatus {
  if (results.length === 0) return 'no-data';
  if (results.some((r) => r.status === 'failed')) return 'has-failures';
  if (results.some((r) => r.status === 'warning')) return 'has-warnings';
  return 'all-passed';
}

async function getBundleId(): Promise<string> {
  // Best-effort: derive from appDataDir path tail (com.abu.app vs com.abu.app.dev)
  try {
    const dir = await appDataDir();
    const match = dir.match(/com\.abu\.app(?:\.dev)?/);
    return match ? match[0] : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function getOSDescription(): Promise<string> {
  try {
    return platform();
  } catch {
    return 'unknown';
  }
}

function generateReadme(opts: CollectOptions, fileList: string[]): string {
  const ts = new Date().toISOString();
  const lines = [
    'Abu 诊断包 / Abu Diagnostic Bundle',
    '',
    `生成时间 / Generated: ${ts}`,
    `版本 / Version: v${APP_VERSION}`,
    '',
    '─── 目的 / Purpose ───────────────────────────────────',
    '',
    '此 zip 由 Abu 「设置 → 诊断」生成，用于排查 bug 时附在 issue 里。',
    'This zip is produced by Abu Settings → Diagnostic, intended to be',
    'attached when reporting bugs.',
    '',
    '─── 隐私 / Privacy ───────────────────────────────────',
    '',
    `消息原文 / Raw message text: ${opts.includeRawText ? '已包含 INCLUDED' : '已脱敏 SCRUBBED'}`,
    'API key / 凭据 / 密钥 / Token: 永远不会包含 NEVER INCLUDED',
    '其它对话 / Other conversations: 不包含 NOT INCLUDED',
    '只有你勾选的对话会被包含；未勾选的对话、API Key、密钥永远不会被包含。',
    'Only the conversations you selected are included; unselected conversations,',
    'API keys, and secrets are never included.',
    '',
    '─── 包内文件 / Files ─────────────────────────────────',
    '',
    ...fileList.map((f) => `  ${f}`),
    '',
    '请只把这个包发给可信任的接收方。',
    'Only share this bundle with trusted recipients.',
    '',
  ];
  return lines.join('\n');
}

export async function collectBundleFiles(opts: CollectOptions): Promise<CollectResult> {
  const files: Record<string, string | Uint8Array> = {};
  let scrubCount = 0;

  // ── meta.json ────────────────────────────────────────────────────────
  const meta = {
    schemaVersion: 1,
    generatedAt: Date.now(),
    appVersion: APP_VERSION,
    bundleId: await getBundleId(),
    os: await getOSDescription(),
    options: {
      includeRawText: opts.includeRawText,
    },
  };
  files['meta.json'] = JSON.stringify(meta, null, 2);

  // ── diagnostic-snapshot.json ────────────────────────────────────────
  const diag = useDiagnosticStore.getState();
  const results = Object.values(diag.results);
  const snapshot: DiagnosticSnapshot = {
    schemaVersion: 1,
    takenAt: diag.lastCheckedAt ?? Date.now(),
    appVersion: APP_VERSION,
    bundleId: meta.bundleId,
    os: meta.os,
    overall: deriveOverall(results),
    results,
  };
  files['diagnostic-snapshot.json'] = JSON.stringify(snapshot, null, 2);

  // ── conversations/<shortId>/* ────────────────────────────────────────
  // Multi-select: opts.conversationIds takes priority over the legacy
  // single-id opts.conversationId. An explicit empty conversationIds list is
  // legal (pure environment/feedback bundle, no conversation content) and
  // must NOT fall back to the active conversation — see resolveConversationIds.
  const chat = useChatStore.getState();
  const ids = resolveConversationIds(opts, chat.activeConversationId);

  // Disambiguate short (8-char) prefixes so two ids don't collide inside the zip.
  const usedShortIds = new Set<string>();
  function shortIdFor(id: string): string {
    let candidate = id.slice(0, 8);
    let len = 8;
    while (usedShortIds.has(candidate) && len < id.length) {
      len += 4;
      candidate = id.slice(0, len);
    }
    if (usedShortIds.has(candidate)) {
      // Extremely unlikely (would require a shared full-length id) — append an index.
      let i = 2;
      while (usedShortIds.has(`${candidate}-${i}`)) i++;
      candidate = `${candidate}-${i}`;
    }
    usedShortIds.add(candidate);
    return candidate;
  }

  // Per-conversation request (default cap, or 'all' to lift it) — still
  // clamped below by the shared global budget.
  const requestedCap = opts.messageCap ?? DEFAULT_DIAGNOSTIC_MESSAGE_CAP;
  const requestedCapNumeric = requestedCap === 'all' ? Number.POSITIVE_INFINITY : requestedCap;
  // Running total across ALL selected conversations — see
  // MAX_TOTAL_DIAGNOSTIC_MESSAGES for why this exists independently of the
  // per-conversation cap.
  let remainingMessageBudget = MAX_TOTAL_DIAGNOSTIC_MESSAGES;

  for (const convId of ids) {
    let conv = chat.conversations[convId];
    if (!conv) {
      // Selected but not currently held in memory (e.g. a conversation from
      // an earlier session that was never opened this run) — load it before
      // giving up, otherwise it's silently dropped from the bundle even
      // though the user explicitly selected it.
      await useChatStore.getState().loadConversation(convId);
      // loadConversation replaces the store's state object, so `chat` (a
      // stale snapshot from before this call) won't reflect it — re-fetch.
      conv = useChatStore.getState().conversations[convId];
    }
    if (!conv) continue;

    const shortId = shortIdFor(convId);
    const dir = `conversations/${shortId}`;

    // Cap to the most-recent messages so a huge conversation can't freeze the
    // main thread during scrub + zip (Bug 2). Older messages are dropped with
    // an explicit note — never silently. The effective cap is also clamped
    // to whatever remains of the global multi-conversation budget.
    const effectiveCap = Math.max(0, Math.min(requestedCapNumeric, remainingMessageBudget));
    const { messages: capped, total, capped: wasCapped } = capDiagnosticMessages(
      conv.messages,
      effectiveCap,
    );
    remainingMessageBudget = Math.max(0, remainingMessageBudget - capped.length);

    const scrubbedMessages = capped.map((m) => {
      const out = scrubMessage(m, { includeRawText: opts.includeRawText });
      if (!opts.includeRawText) scrubCount++;
      return out;
    });
    files[`${dir}/messages.jsonl`] = scrubbedMessages.map((m) => JSON.stringify(m)).join('\n');
    if (wasCapped) {
      const globalBudgetWasBinding = effectiveCap < requestedCapNumeric;
      files[`${dir}/_truncation-note.txt`] = globalBudgetWasBinding
        ? `Included the most recent ${capped.length} of ${total} messages ` +
          `(truncated because the overall diagnostic export budget of ` +
          `${MAX_TOTAL_DIAGNOSTIC_MESSAGES} total messages across all selected ` +
          `conversations was reached). Select fewer conversations, or export them ` +
          `separately, to include more history for this one.\n`
        : `Included the most recent ${capped.length} of ${total} messages ` +
          `(older messages were omitted to keep the export small).\n`;
    }

    const indexEntry = chat.conversationIndex[convId];
    if (indexEntry) {
      files[`${dir}/index-entry.json`] = JSON.stringify(scrubSecrets(indexEntry), null, 2);
    }
  }

  // ── feedback/description.txt ─────────────────────────────────────────
  if (opts.description && opts.description.trim()) {
    files['feedback/description.txt'] = opts.description.trim();
  }

  // ── feedback/screenshots/* ───────────────────────────────────────────
  // Binary entries — kept as raw Uint8Array so the bundler can zip them
  // without a text round-trip. Guard against name collisions defensively;
  // callers are expected to pass unique names (e.g. 01.png, 02.png).
  const usedScreenshotNames = new Set<string>();
  for (const s of opts.screenshots ?? []) {
    let name = s.name;
    let i = 2;
    while (usedScreenshotNames.has(name)) {
      const dot = s.name.lastIndexOf('.');
      name = dot === -1 ? `${s.name}-${i}` : `${s.name.slice(0, dot)}-${i}${s.name.slice(dot)}`;
      i++;
    }
    usedScreenshotNames.add(name);
    files[`feedback/screenshots/${name}`] = s.bytes;
  }

  // ── settings/* ───────────────────────────────────────────────────────
  const settings = useSettingsStore.getState();
  // Pick known data fields only — actions / transient UI state are skipped.
  const settingsSnapshot = {
    activeModel: settings.activeModel,
    theme: settings.theme,
    language: settings.language,
    sandboxEnabled: settings.sandboxEnabled,
    networkIsolationEnabled: settings.networkIsolationEnabled,
    allowPrivateNetworks: settings.allowPrivateNetworks,
    closeAction: settings.closeAction,
    agentMaxTurns: settings.agentMaxTurns,
    maxOutputTokens: settings.maxOutputTokens,
    contextWindowSize: settings.contextWindowSize,
    permissionMode: settings.permissionMode,
    soul: settings.soul,
    behaviorSensorEnabled: settings.behaviorSensorEnabled,
    computerUseEnabled: settings.computerUseEnabled,
    allowSkillCommands: settings.allowSkillCommands,
    disabledSkills: settings.disabledSkills,
    disabledAgents: settings.disabledAgents,
  };
  files['settings/settings.json'] = JSON.stringify(scrubSecrets(settingsSnapshot), null, 2);

  files['settings/providers.json'] = JSON.stringify(
    scrubSecrets(settings.providers.map((p) => ({
      id: p.id,
      name: p.name,
      source: p.source,
      enabled: p.enabled,
      apiFormat: p.apiFormat,
      baseUrl: p.baseUrl,
      // apiKey deliberately included so scrubSecrets can replace it with [REDACTED]
      apiKey: p.apiKey,
      models: p.models,
      defaultModelId: p.defaultModelId,
      capabilities: p.capabilities,
      status: p.status,
      statusMessage: p.statusMessage,
      statusLatency: p.statusLatency,
      lastChecked: p.lastChecked,
    }))),
    null,
    2,
  );

  // ── skills/installed.json ────────────────────────────────────────────
  try {
    const ws = useWorkspaceStore.getState().currentPath;
    const skills = await skillLoader.discoverSkills(ws);
    files['skills/installed.json'] = JSON.stringify(
      skills.map((s) => ({
        name: s.name,
        source: s.source,
        description: s.description,
      })),
      null,
      2,
    );
  } catch (e) {
    files['skills/installed.json'] = JSON.stringify({ error: e instanceof Error ? e.message : String(e) }, null, 2);
  }

  // ── mcp/servers.json ─────────────────────────────────────────────────
  const mcpServers = (Object.values(useMCPStore.getState().servers) as MCPServerEntry[]).map((srv) => ({
    name: srv.config.name,
    transport: srv.config.transport,
    url: srv.config.url, // url is fine; tokens live in headers which scrubSecrets handles
    enabled: srv.config.enabled,
    headers: srv.config.headers, // → scrubbed
    args: srv.config.args,
    status: srv.status,
    error: srv.error,
    toolCount: srv.tools?.length ?? 0,
    lastConnectedAt: srv.lastConnectedAt,
  }));
  files['mcp/servers.json'] = JSON.stringify(scrubSecrets(mcpServers), null, 2);

  // ── permissions/* ────────────────────────────────────────────────────
  try {
    const dataDir = await appDataDir();
    // The capabilities file is under the app resource, not appData. Skip if
    // we can't reach it from within the running app — readTextFile will
    // fail under app:// scheme. Best-effort: at minimum capture the grants.
    try {
      const capPath = joinPath(dataDir, '..', 'Resources', 'capabilities', 'default.json');
      files['permissions/capabilities.json'] = await readTextFile(capPath);
    } catch {
      files['permissions/capabilities.json'] = JSON.stringify(
        { note: 'capabilities file not readable from app process — see GitHub for current config' },
        null,
        2,
      );
    }
  } catch (e) {
    files['permissions/capabilities.json'] = JSON.stringify(
      { error: e instanceof Error ? e.message : String(e) },
      null,
      2,
    );
  }

  const permState = usePermissionStore.getState();
  files['permissions/grants.json'] = JSON.stringify(
    scrubSecrets({
      persistedGrants: permState.persistedGrants,
      sessionGrants: permState.sessionGrants,
    }),
    null,
    2,
  );

  // ── logs/runtime.jsonl ───────────────────────────────────────────────
  // In-memory ring buffer from the structured logger. Captures recent
  // agentLoop / toolExecutor / contextManager / LLM events including the
  // warn/error level that's the highest-value debug signal.
  try {
    const entries = getRecentLogs().slice(-RUNTIME_LOG_LIMIT);
    files['logs/runtime.jsonl'] = entries.map((e) => JSON.stringify(e)).join('\n');
  } catch (e) {
    files['logs/runtime.jsonl'] = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }

  // ── logs/YYYY-MM-DD.log ──────────────────────────────────────────────
  // Today + yesterday's on-disk warn/error log files. Best-effort —
  // missing files (new install, no warns/errors yet) are silently skipped.
  try {
    const logDir = await getLogDirPath();
    if (logDir) {
      for (const daysBack of [0, 1]) {
        const name = logFileNameForDaysBack(daysBack);
        try {
          const content = await readTextFile(joinPath(logDir, name));
          const lines = content.split('\n');
          files[`logs/${name}`] = lines.slice(-DISK_LOG_TAIL_LINES).join('\n');
        } catch {
          // File not present — skip silently
        }
      }
    }
  } catch (e) {
    files['logs/disk-read-error.txt'] = e instanceof Error ? e.message : String(e);
  }

  // ── stores/versions.json ─────────────────────────────────────────────
  // Schema versions of all persisted Zustand stores. Lets PM spot
  // migration-related bugs at a glance without needing the user's
  // localStorage dump.
  const storeVersions: Record<string, number | 'missing' | 'parse-error'> = {};
  for (const key of PERSISTED_STORE_KEYS) {
    const raw = localStorage.getItem(key);
    if (!raw) {
      storeVersions[key] = 'missing';
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as { version?: number };
      storeVersions[key] = parsed.version ?? 'missing';
    } catch {
      storeVersions[key] = 'parse-error';
    }
  }
  files['stores/versions.json'] = JSON.stringify(storeVersions, null, 2);

  // ── conversations/index.json ─────────────────────────────────────────
  // Metadata for ALL conversations (titles, counts, timestamps). No
  // message content. Helps diagnose "conversation disappeared / wrong
  // conversation loaded" type bugs.
  // workspacePath / imChannelId / triggerId deliberately omitted —
  // user-local paths and channel IDs are privacy-sensitive and rarely
  // needed for diagnostic.
  try {
    const allMeta = Object.values(chat.conversationIndex).map((m) => ({
      id: m.id,
      title: m.title,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      messageCount: m.messageCount,
      totalCost: m.totalCost,
      readOnly: m.readOnly,
    }));
    files['conversations/index.json'] = JSON.stringify(scrubSecrets(allMeta), null, 2);
  } catch (e) {
    files['conversations/index.json'] = JSON.stringify({ error: e instanceof Error ? e.message : String(e) }, null, 2);
  }

  // ── schedule/summary.json ────────────────────────────────────────────
  // Scheduled-task status snapshot. Deliberately excludes name / prompt /
  // description — those are user content. id / status / timing / skill
  // binding are what PM needs to diagnose scheduler bugs.
  try {
    const tasks = Object.values(useScheduleStore.getState().tasks).map((t) => ({
      id: t.id,
      status: t.status,
      skillName: t.skillName,
      lastRunAt: t.lastRunAt,
      nextRunAt: t.nextRunAt,
    }));
    files['schedule/summary.json'] = JSON.stringify({ taskCount: tasks.length, tasks }, null, 2);
  } catch (e) {
    files['schedule/summary.json'] = JSON.stringify({ error: e instanceof Error ? e.message : String(e) }, null, 2);
  }

  // ── README.txt ───────────────────────────────────────────────────────
  const fileList = Object.keys(files).sort().concat(['README.txt']);
  files['README.txt'] = generateReadme(opts, fileList);

  return { files, scrubbedTextCount: scrubCount };
}
