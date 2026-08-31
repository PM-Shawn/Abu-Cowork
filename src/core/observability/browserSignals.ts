/**
 * Browser-automation observability signals — pure types + pure functions.
 *
 * Purpose (batch 1, docs/plans/2026-09-01-browser-batch1-observability.md):
 * turn "the user got annoyed and reported a bug" into "the diagnostic bundle
 * already says which site/tool degraded". This module ONLY defines event
 * shapes and pure aggregation/classification — it collects nothing on its
 * own. `src/core/tools/registry.ts` (the browser tool call/approval
 * boundary), `src/stores/previewStore.ts` (browser workspace-tab lifecycle)
 * and `src/core/scheduler/scheduler.ts` (trigger drift) are the collection
 * points that call into this module.
 *
 * Hard constraints (see the plan's "Global Constraints"):
 * - Zero behavior change: every record/track/collect function here is
 *   best-effort and MUST NOT throw in a way that could break a caller that
 *   forgets to wrap it — see `recordBrowserSignal`/`recordSchedulerDriftSignal`.
 * - No page content: `deriveTargetKey` only ever serializes a locator's
 *   structural fields (`ref`/`css`/`xpath`) or a CSS `selector` string, never
 *   `text`/`role`/`name`/`testId` (which can echo literal page text) and
 *   never a fill/select `value` (literal user/page content).
 * - Local only: nothing in this module performs network I/O. Persistence is
 *   an in-memory rolling buffer; the diagnostic bundle pipeline
 *   (`src/core/diagnostic/collect.ts`) is what turns it into an on-disk
 *   artifact, mirroring how `src/core/logging/logger.ts`'s ring buffer is
 *   already exported into diagnostic bundles today.
 */

// ── Event shapes ──────────────────────────────────────────────────────────

export type BrowserSignalEvent =
  | { kind: 'tool_call'; tool: string; tabId?: number; origin?: string; frameHint?: boolean; ok: boolean; errorClass?: string; durationMs: number }
  | { kind: 'fallback_to_script' }
  | { kind: 'repeat_action'; tool: string; targetKey: string; count: number }
  | { kind: 'confirm_prompt'; origin?: string }
  | { kind: 'blocked_page'; className: 'http_429' | 'challenge' | 'verify_wall' }
  | { kind: 'tab_lifetime'; event: 'created' | 'closed'; aliveMs?: number }
  | { kind: 'task_end'; browserToolCalls: number; unfinishedHint: boolean };

/** Fields the collection layer (registry.ts et al.) attaches uniformly to every event. */
export interface BrowserSignalContext {
  platform: string;
  appVersion: string;
  channel: 'builtin' | 'chrome';
  conversationId?: string;
  ts: number;
}

export type BrowserSignalRecord = BrowserSignalEvent & BrowserSignalContext;

export function buildBrowserSignalRecord(
  event: BrowserSignalEvent,
  context: BrowserSignalContext,
): BrowserSignalRecord {
  return { ...event, ...context } as BrowserSignalRecord;
}

/** F1.4: scheduler trigger drift (planned vs. actual fire time), + an optional
 *  per-run token cost placeholder — see scheduler.ts collection point doc for
 *  why `tokensUsed` is usually absent in this batch. */
export interface SchedulerDriftSignal {
  kind: 'scheduler_drift';
  taskId: string;
  plannedAt: number;
  actualAt: number;
  driftMs: number;
  tokensUsed?: number;
}

export function buildSchedulerDriftSignal(
  taskId: string,
  plannedAt: number,
  actualAt: number,
  tokensUsed?: number,
): SchedulerDriftSignal {
  return {
    kind: 'scheduler_drift',
    taskId,
    plannedAt,
    actualAt,
    driftMs: actualAt - plannedAt,
    ...(tokensUsed !== undefined ? { tokensUsed } : {}),
  };
}

// ── browserChannelForTool ─────────────────────────────────────────────────

/** Built-in browser runtime + Chrome extension bridge — mirrors
 *  `BROWSER_SERVER_NAMES` in `core/permissions/browserToolPolicy.ts`
 *  (not imported directly to keep this module dependency-free/pure). */
export function browserChannelForTool(namespacedName: string): 'builtin' | 'chrome' | undefined {
  if (namespacedName.startsWith('abu-browser-bridge__')) return 'chrome';
  if (namespacedName.startsWith('abu-browser__')) return 'builtin';
  return undefined;
}

// ── RepeatTracker ─────────────────────────────────────────────────────────

/** Per-conversation same-tool+same-target consecutive-call counter.
 *  Emits (shouldEmit=true) once the streak reaches 3; resets on any change
 *  of tool or target. Caller owns the instance's lifetime/scoping. */
export class RepeatTracker {
  private lastTool: string | null = null;
  private lastTargetKey: string | null = null;
  private count = 0;

  track(tool: string, targetKey: string): { count: number; shouldEmit: boolean } {
    if (tool === this.lastTool && targetKey === this.lastTargetKey) {
      this.count += 1;
    } else {
      this.lastTool = tool;
      this.lastTargetKey = targetKey;
      this.count = 1;
    }
    return { count: this.count, shouldEmit: this.count >= 3 };
  }

  reset(): void {
    this.lastTool = null;
    this.lastTargetKey = null;
    this.count = 0;
  }
}

// ── FallbackToScriptTracker ───────────────────────────────────────────────

/** Detects "the standard tool failed, so execute_js was reached for" —
 *  a tiny ring state machine over one conversation's browser tool calls. */
export class FallbackToScriptTracker {
  private previousFailed = false;

  /** Call once per browser tool call, in chronological order. Returns true
   *  when this call is execute_js AND the immediately preceding browser tool
   *  call in this conversation failed. */
  note(tool: string, ok: boolean): boolean {
    const isFallback = tool === 'execute_js' && this.previousFailed;
    this.previousFailed = !ok;
    return isFallback;
  }
}

// ── classifyBlockedPage ───────────────────────────────────────────────────

const HTTP_429_PATTERNS = [/\b429\b/, /too many requests/i];
const CHALLENGE_PATTERNS = [/cloudflare/i, /checking your browser/i, /cf-browser-verification/i, /just a moment/i];
const VERIFY_WALL_PATTERNS = [/verify you are human/i, /complete the captcha/i, /security check/i, /verify[^.]{0,20}robot/i];

/** Conservative, keyword-based classifier — "宁漏勿误报" (prefer a missed
 *  detection over a false positive). Never throws. */
export function classifyBlockedPage(resultText: string | undefined | null): 'http_429' | 'challenge' | 'verify_wall' | null {
  if (!resultText) return null;
  try {
    if (HTTP_429_PATTERNS.some((p) => p.test(resultText))) return 'http_429';
    if (CHALLENGE_PATTERNS.some((p) => p.test(resultText))) return 'challenge';
    if (VERIFY_WALL_PATTERNS.some((p) => p.test(resultText))) return 'verify_wall';
    return null;
  } catch {
    return null;
  }
}

// ── classifyBrowserToolError / detectFrameHint / isBrowserToolResultError ──

const ERROR_CLASS_PATTERNS: [string, RegExp][] = [
  ['timeout', /\btimeout\b|timed out/i],
  ['not_connected', /extension is not connected|not connected/i],
  ['not_found', /no (?:element|tab|match)(?:es)? found|not found/i],
  ['locator_ambiguous', /several match|ambiguous/i],
  ['aborted', /\baborted\b|cancelled|canceled/i],
];

/** Coarse error classification for a tool_call's `errorClass` field. Returns
 *  undefined for anything that doesn't look like an error result. */
export function classifyBrowserToolError(resultText: string | undefined | null): string | undefined {
  if (!resultText) return undefined;
  if (!/^\s*error\b/i.test(resultText)) return undefined;
  for (const [cls, pattern] of ERROR_CLASS_PATTERNS) {
    if (pattern.test(resultText)) return cls;
  }
  return 'unknown_error';
}

/** Flags a possible iframe-related failure (PRD hypothesis: iframes are a
 *  hidden root cause behind selector-resolution failures). */
export function detectFrameHint(resultText: string | undefined | null): boolean {
  if (!resultText) return false;
  return /\biframe\b|\bframe\b/i.test(resultText);
}

/** This codebase's error-result convention: every failing ToolResult string
 *  (approval denial, execution error, MCP transport error — see
 *  `abu-browser-bridge/src/tools.ts`'s `formatResult`) starts with "Error". */
export function isBrowserToolResultError(resultText: string): boolean {
  return /^\s*error\b/i.test(resultText);
}

// ── deriveTargetKey ───────────────────────────────────────────────────────

/** Structural-only locator fingerprint for repeat-action detection.
 *  Deliberately excludes `text`/`role`/`name`/`testId` locator strategies
 *  (can echo literal page text) and any `value` field (literal user/page
 *  content) — see the module doc's privacy constraint. */
export function deriveTargetKey(toolName: string, input: Record<string, unknown>): string {
  const rawLocator = input.locator;
  if (typeof rawLocator === 'string') {
    try {
      const parsed = JSON.parse(rawLocator) as Record<string, unknown>;
      if (typeof parsed.ref === 'string') return `ref:${parsed.ref}`;
      if (typeof parsed.css === 'string') return `css:${parsed.css}`;
      if (typeof parsed.xpath === 'string') return `xpath:${parsed.xpath}`;
      return 'locator:other';
    } catch {
      return 'locator:unparsable';
    }
  }
  if (typeof input.selector === 'string' && input.selector.length > 0) {
    return `selector:${input.selector}`;
  }
  if (typeof input.tabId === 'number' || typeof input.tabId === 'string') {
    return `tabId:${input.tabId}`;
  }
  return `tool:${toolName}`;
}

// ── Browser signal rolling buffer ─────────────────────────────────────────
// In-memory ring buffer, same eviction pattern as src/core/logging/logger.ts.
// Turned into an on-disk JSONL artifact by the diagnostic bundle pipeline
// (src/core/diagnostic/collect.ts), never written to disk continuously —
// this app has no continuous local telemetry writer for info-level events
// (only logger.ts's warn/error path persists eagerly), and adding one here
// would be new always-on disk I/O this batch does not ask for.
const MAX_BROWSER_SIGNAL_ENTRIES = 5000;
let browserSignalBuffer: BrowserSignalRecord[] = [];
let browserSignalWriteIndex = 0;
let browserSignalCount = 0;

/** Never throws — a bad/malformed record is silently dropped. Observability
 *  must never become a reason the app misbehaves. */
export function recordBrowserSignal(record: BrowserSignalRecord): void {
  try {
    if (!record || typeof record !== 'object') return;
    if (browserSignalCount < MAX_BROWSER_SIGNAL_ENTRIES) {
      browserSignalBuffer.push(record);
      browserSignalCount++;
    } else {
      browserSignalBuffer[browserSignalWriteIndex] = record;
    }
    browserSignalWriteIndex = (browserSignalWriteIndex + 1) % MAX_BROWSER_SIGNAL_ENTRIES;
  } catch {
    // Observability must never change product behavior.
  }
}

export function getRecentBrowserSignals(): BrowserSignalRecord[] {
  const total = Math.min(browserSignalCount, MAX_BROWSER_SIGNAL_ENTRIES);
  const start = browserSignalCount < MAX_BROWSER_SIGNAL_ENTRIES ? 0 : browserSignalWriteIndex;
  const result: BrowserSignalRecord[] = [];
  for (let i = 0; i < total; i++) result.push(browserSignalBuffer[(start + i) % MAX_BROWSER_SIGNAL_ENTRIES]);
  return result;
}

/** Test/diagnostic utility — clears the whole rolling buffer. */
export function clearBrowserSignals(): void {
  browserSignalBuffer = [];
  browserSignalWriteIndex = 0;
  browserSignalCount = 0;
}

/** Best-effort wrapper for collection sites: builds and records a signal
 *  without ever letting a construction error escape into the caller. */
export function safeRecordBrowserSignal(build: () => BrowserSignalRecord): void {
  try {
    recordBrowserSignal(build());
  } catch {
    // Observability must never change product behavior.
  }
}

// ── Scheduler drift rolling buffer ────────────────────────────────────────

const MAX_SCHEDULER_DRIFT_ENTRIES = 1000;
let schedulerDriftBuffer: SchedulerDriftSignal[] = [];
let schedulerDriftWriteIndex = 0;
let schedulerDriftCount = 0;

export function recordSchedulerDriftSignal(signal: SchedulerDriftSignal): void {
  try {
    if (!signal || typeof signal !== 'object') return;
    if (schedulerDriftCount < MAX_SCHEDULER_DRIFT_ENTRIES) {
      schedulerDriftBuffer.push(signal);
      schedulerDriftCount++;
    } else {
      schedulerDriftBuffer[schedulerDriftWriteIndex] = signal;
    }
    schedulerDriftWriteIndex = (schedulerDriftWriteIndex + 1) % MAX_SCHEDULER_DRIFT_ENTRIES;
  } catch {
    // Observability must never change product behavior.
  }
}

export function getRecentSchedulerDriftSignals(): SchedulerDriftSignal[] {
  const total = Math.min(schedulerDriftCount, MAX_SCHEDULER_DRIFT_ENTRIES);
  const start = schedulerDriftCount < MAX_SCHEDULER_DRIFT_ENTRIES ? 0 : schedulerDriftWriteIndex;
  const result: SchedulerDriftSignal[] = [];
  for (let i = 0; i < total; i++) result.push(schedulerDriftBuffer[(start + i) % MAX_SCHEDULER_DRIFT_ENTRIES]);
  return result;
}

export function clearSchedulerDriftSignals(): void {
  schedulerDriftBuffer = [];
  schedulerDriftWriteIndex = 0;
  schedulerDriftCount = 0;
}

export function safeRecordSchedulerDriftSignal(build: () => SchedulerDriftSignal): void {
  try {
    recordSchedulerDriftSignal(build());
  } catch {
    // Observability must never change product behavior.
  }
}

// ── Per-conversation stateful trackers (RepeatTracker/FallbackToScriptTracker) ──

const repeatTrackers = new Map<string, RepeatTracker>();
const fallbackTrackers = new Map<string, FallbackToScriptTracker>();

/** Conversation-less calls (no confirmed owner, e.g. an unusual headless
 *  path) share one bucket — approximate observability, not a correctness
 *  boundary. */
const NO_CONVERSATION_KEY = '__no_conversation__';

function getRepeatTracker(key: string): RepeatTracker {
  let tracker = repeatTrackers.get(key);
  if (!tracker) {
    tracker = new RepeatTracker();
    repeatTrackers.set(key, tracker);
  }
  return tracker;
}

function getFallbackTracker(key: string): FallbackToScriptTracker {
  let tracker = fallbackTrackers.get(key);
  if (!tracker) {
    tracker = new FallbackToScriptTracker();
    fallbackTrackers.set(key, tracker);
  }
  return tracker;
}

/** Convenience wrapper the registry.ts collection point calls once per
 *  browser tool call: advances both per-conversation trackers and reports
 *  what to emit. Never throws. */
export function noteBrowserToolOutcome(
  conversationId: string | undefined,
  tool: string,
  targetKey: string,
  ok: boolean,
): { repeat: { count: number; shouldEmit: boolean }; fallback: boolean } {
  try {
    const key = conversationId ?? NO_CONVERSATION_KEY;
    const repeat = getRepeatTracker(key).track(tool, targetKey);
    const fallback = getFallbackTracker(key).note(tool, ok);
    return { repeat, fallback };
  } catch {
    return { repeat: { count: 1, shouldEmit: false }, fallback: false };
  }
}

/** Test utility / conversation teardown: clears one conversation's trackers,
 *  or all of them when no id is given. */
export function clearBrowserToolTrackers(conversationId?: string): void {
  if (conversationId) {
    repeatTrackers.delete(conversationId);
    fallbackTrackers.delete(conversationId);
    return;
  }
  repeatTrackers.clear();
  fallbackTrackers.clear();
}

// ── Tab lifetime tracking ─────────────────────────────────────────────────

const tabCreatedAt = new Map<string, number>();

/** Record a browser workspace-tab's creation time (previewStore.ts's
 *  `openBrowser` adoption branch). */
export function noteTabCreated(tabId: string, now: number = Date.now()): void {
  try {
    tabCreatedAt.set(tabId, now);
  } catch {
    // Observability must never change product behavior.
  }
}

/** Returns the tab's alive duration in ms, or undefined if it was never
 *  recorded as created (or was already closed once). Forgets the tab either
 *  way so a later reuse of the same id starts fresh. */
export function noteTabClosed(tabId: string, now: number = Date.now()): number | undefined {
  try {
    const createdAt = tabCreatedAt.get(tabId);
    tabCreatedAt.delete(tabId);
    return createdAt !== undefined ? now - createdAt : undefined;
  } catch {
    return undefined;
  }
}

// ── F1.2: approximate task success rate ───────────────────────────────────

export interface TaskSuccessInputs {
  /** >=2 consecutive failed tool_call events within the task. */
  hadConsecutiveFailures: boolean;
  /** Reserved for batch 2.5's takeover signal — batch 1 has no source for
   *  this yet, so callers pass `false` until then. */
  hadManualTakeover: boolean;
  /** The task only reached completion via the execute_js fallback. */
  usedScriptFallback: boolean;
}

/** F1.2 口径: "无连续失败 + 无用户手动接管 + 非 execute_js 兜底完成". */
export function approximateTaskSuccess(inputs: TaskSuccessInputs): boolean {
  return !inputs.hadConsecutiveFailures && !inputs.hadManualTakeover && !inputs.usedScriptFallback;
}

// ── Diagnostic-bundle summary aggregation ─────────────────────────────────

export interface BrowserTaskSummary {
  taskCount: number;
  /** F1.2 approximate success rate across task_end-delimited segments, or
   *  null when there is no task_end data to derive it from. */
  successRateApprox: number | null;
  fallbackCount: number;
  confirmPromptCount: number;
  repeatActionTop3: Array<{ tool: string; targetKey: string; count: number }>;
  blockedPageCount: number;
  avgTabAliveMs: number | null;
  bySiteAndPlatform: Array<{ origin: string; platform: string; toolCallCount: number; okRate: number }>;
}

const CONSECUTIVE_FAILURE_THRESHOLD = 2;

function hasConsecutiveToolCallFailures(segment: BrowserSignalRecord[], threshold: number): boolean {
  let streak = 0;
  for (const record of segment) {
    if (record.kind !== 'tool_call') continue;
    if (!record.ok) {
      streak += 1;
      if (streak >= threshold) return true;
    } else {
      streak = 0;
    }
  }
  return false;
}

/** Aggregates a flat list of browser signal records (as returned by
 *  `getRecentBrowserSignals()`) into the diagnostic bundle's "browser task
 *  summary" section. Pure — takes records in, does no I/O. */
export function summarizeBrowserSignals(records: BrowserSignalRecord[]): BrowserTaskSummary {
  const taskCount = records.filter((r) => r.kind === 'task_end').length;

  // Task boundaries are per-conversation: split each conversation's records
  // (sorted by ts) at every task_end it contains.
  const byConversation = new Map<string, BrowserSignalRecord[]>();
  for (const record of records) {
    const key = record.conversationId ?? '__unknown__';
    const list = byConversation.get(key);
    if (list) list.push(record);
    else byConversation.set(key, [record]);
  }

  let evaluatedTasks = 0;
  let successCount = 0;
  for (const conversationRecords of byConversation.values()) {
    const sorted = [...conversationRecords].sort((a, b) => a.ts - b.ts);
    let segmentStart = 0;
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].kind !== 'task_end') continue;
      const segment = sorted.slice(segmentStart, i + 1);
      evaluatedTasks += 1;
      const hadConsecutiveFailures = hasConsecutiveToolCallFailures(segment, CONSECUTIVE_FAILURE_THRESHOLD);
      const usedScriptFallback = segment.some((r) => r.kind === 'fallback_to_script');
      if (approximateTaskSuccess({ hadConsecutiveFailures, hadManualTakeover: false, usedScriptFallback })) {
        successCount += 1;
      }
      segmentStart = i + 1;
    }
  }
  const successRateApprox = evaluatedTasks > 0 ? successCount / evaluatedTasks : null;

  const fallbackCount = records.filter((r) => r.kind === 'fallback_to_script').length;
  const confirmPromptCount = records.filter((r) => r.kind === 'confirm_prompt').length;
  const blockedPageCount = records.filter((r) => r.kind === 'blocked_page').length;

  const repeatMax = new Map<string, { tool: string; targetKey: string; count: number }>();
  for (const record of records) {
    if (record.kind !== 'repeat_action') continue;
    const key = `${record.tool} ${record.targetKey}`;
    const existing = repeatMax.get(key);
    if (!existing || record.count > existing.count) {
      repeatMax.set(key, { tool: record.tool, targetKey: record.targetKey, count: record.count });
    }
  }
  const repeatActionTop3 = Array.from(repeatMax.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  const tabAliveDurations = records
    .filter((r): r is Extract<BrowserSignalRecord, { kind: 'tab_lifetime' }> =>
      r.kind === 'tab_lifetime' && r.event === 'closed' && typeof r.aliveMs === 'number')
    .map((r) => r.aliveMs as number);
  const avgTabAliveMs = tabAliveDurations.length > 0
    ? tabAliveDurations.reduce((a, b) => a + b, 0) / tabAliveDurations.length
    : null;

  const siteMap = new Map<string, { origin: string; platform: string; toolCallCount: number; okCount: number }>();
  for (const record of records) {
    if (record.kind !== 'tool_call') continue;
    const origin = record.origin ?? 'unknown';
    const platform = record.platform ?? 'unknown';
    const key = `${origin} ${platform}`;
    const entry = siteMap.get(key) ?? { origin, platform, toolCallCount: 0, okCount: 0 };
    entry.toolCallCount += 1;
    if (record.ok) entry.okCount += 1;
    siteMap.set(key, entry);
  }
  const bySiteAndPlatform = Array.from(siteMap.values()).map((entry) => ({
    origin: entry.origin,
    platform: entry.platform,
    toolCallCount: entry.toolCallCount,
    okRate: entry.toolCallCount > 0 ? entry.okCount / entry.toolCallCount : 0,
  }));

  return {
    taskCount,
    successRateApprox,
    fallbackCount,
    confirmPromptCount,
    repeatActionTop3,
    blockedPageCount,
    avgTabAliveMs,
    bySiteAndPlatform,
  };
}
