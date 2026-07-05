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
  /** Conversation ID to embed (defaults to active). May be null/undefined. */
  conversationId?: string | null;
  /**
   * Cap on how many (most-recent) messages to embed. A large conversation
   * (1000s of messages) serialized whole freezes the main thread during zip
   * (Bug 2). Defaults to the last {@link DEFAULT_DIAGNOSTIC_MESSAGE_CAP};
   * pass 'all' to include everything.
   */
  messageCap?: number | 'all';
}

/** Default number of most-recent messages embedded in a diagnostic bundle. */
export const DEFAULT_DIAGNOSTIC_MESSAGE_CAP = 200;

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
  if (cap === 'all' || total <= cap) return { messages, total, capped: false };
  return { messages: messages.slice(-cap), total, capped: true };
}

interface CollectResult {
  /** Map of "path inside zip" → "string contents". */
  files: Record<string, string>;
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
  const files: Record<string, string> = {};
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

  // ── conversation/* ───────────────────────────────────────────────────
  const chat = useChatStore.getState();
  const convId = opts.conversationId ?? chat.activeConversationId;
  if (convId) {
    const conv = chat.conversations[convId];
    if (conv) {
      // Cap to the most-recent messages so a huge conversation can't freeze the
      // main thread during scrub + zip (Bug 2). Older messages are dropped with
      // an explicit note — never silently.
      const { messages: capped, total, capped: wasCapped } = capDiagnosticMessages(
        conv.messages,
        opts.messageCap ?? DEFAULT_DIAGNOSTIC_MESSAGE_CAP,
      );
      const scrubbedMessages = capped.map((m) => {
        const out = scrubMessage(m, { includeRawText: opts.includeRawText });
        if (!opts.includeRawText) scrubCount++;
        return out;
      });
      files['conversation/messages.jsonl'] = scrubbedMessages.map((m) => JSON.stringify(m)).join('\n');
      if (wasCapped) {
        files['conversation/_truncation-note.txt'] =
          `Included the most recent ${capped.length} of ${total} messages ` +
          `(capped to keep the export responsive). Re-export with the "all messages" ` +
          `option to include the full history.\n`;
      }

      const indexEntry = chat.conversationIndex[convId];
      if (indexEntry) {
        files['conversation/index-entry.json'] = JSON.stringify(scrubSecrets(indexEntry), null, 2);
      }
    }
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

  // ── conversation/index.json ──────────────────────────────────────────
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
    files['conversation/index.json'] = JSON.stringify(scrubSecrets(allMeta), null, 2);
  } catch (e) {
    files['conversation/index.json'] = JSON.stringify({ error: e instanceof Error ? e.message : String(e) }, null, 2);
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
