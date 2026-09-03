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
import { getPlatform } from '../../utils/platform';
import { APP_VERSION } from '../../utils/version';
// Type-only: erased at build time, so this module stays runtime-dependency-free
// (see the module doc). Importing the union instead of re-declaring it is
// deliberate — a hand-copied second definition is how the operation-class
// vocabulary drifts between the gate and the report that describes the gate.
import type { BrowserOperationClass, BrowserDenialReasonCode } from '../permissions/browserToolPolicy';

// ── Event shapes ──────────────────────────────────────────────────────────

export type BrowserSignalEvent =
  | { kind: 'tool_call'; tool: string; tabId?: number; origin?: string; frameHint?: boolean; ok: boolean; errorClass?: string; durationMs: number }
  | { kind: 'fallback_to_script' }
  | { kind: 'repeat_action'; tool: string; targetKey: string; count: number }
  | { kind: 'confirm_prompt'; origin?: string }
  | { kind: 'blocked_page'; className: 'http_429' | 'challenge' | 'verify_wall' }
  | { kind: 'tab_lifetime'; event: 'created' | 'closed'; aliveMs?: number }
  | { kind: 'task_end'; browserToolCalls: number; unfinishedHint: boolean }
  /**
   * U7 / G1 — the authorization gate refused a browser action.
   *
   * Until this event existed, a refusal left NO trace here at all: the run
   * result carried a sentence and the tool result carried a diagnostic, but
   * the signal buffer (and therefore the unattended task report) saw an
   * action that simply never happened. A report whose "blocked actions"
   * section is structurally always empty is worse than no report.
   *
   * `reason` is the SAME closed taxonomy the gate uses to pick the sentence
   * it shows the user (`browserToolPolicy.BrowserDenialReasonCode`), not a
   * parallel string set — one vocabulary, two renderings.
   */
  | {
      kind: 'gate_denied';
      tool: string;
      opClass: BrowserOperationClass;
      origin?: string;
      reason: BrowserDenialReasonCode;
      runMode: 'attended' | 'unattended';
    }
  /**
   * U7 / G2 — a human answered (or failed to answer) an unattended approval
   * over IM. This is the ONLY human decision in the whole unattended path,
   * and it used to land without a trace.
   *
   * Recorded once per real round-trip: a coalesced follower or a cached
   * answer must NOT emit another one, or "you approved 1 time" becomes "you
   * approved 14 times" for a chatty tool.
   */
  | {
      kind: 'approval';
      via: 'im';
      outcome: BrowserApprovalOutcome;
      opClass: BrowserOperationClass;
      origin?: string;
    };

/**
 * What became of one approval round-trip. Mirrors `ImApprovalResult.cause`
 * (`core/im/pendingApprovals.ts`) rather than re-bucketing it: "nobody
 * answered" and "there was nobody to ask" are different things to tell a user
 * at 8am, and collapsing them here would make the report unable to say which.
 */
export type BrowserApprovalOutcome =
  | 'approved'
  | 'declined'
  | 'timeout'
  | 'no-channel'
  | 'too-many'
  | 'undeliverable'
  | 'aborted';

/** Fields the collection layer (registry.ts et al.) attaches uniformly to every event. */
export interface BrowserSignalContext {
  platform: string;
  appVersion: string;
  channel: 'builtin' | 'chrome';
  conversationId?: string;
  /**
   * The agent loop this signal was produced by (`ToolExecutionContext.loopId`).
   * Absent for collection points that have no loop in hand (the workspace-tab
   * lifecycle in `previewStore.ts`). Carried so a run's signals can be
   * correlated in a diagnostic bundle; the run report slices with the
   * sequence cursor below, which does not depend on it being present.
   */
  loopId?: string;
  ts: number;
}

export type BrowserSignalRecord = BrowserSignalEvent & BrowserSignalContext;

/**
 * A record as it sits in the buffer: stamped with a process-monotonic sequence
 * number by `recordBrowserSignal`.
 *
 * This is what makes "the signals THIS run produced" answerable without a
 * clock. A consumer captures `getBrowserSignalCursor()` before the run and
 * keeps records whose `seq` is greater — immune to clock skew, DST, an NTP
 * step, and to two runs of the same scheduled task sharing a conversation.
 */
export type StoredBrowserSignalRecord = BrowserSignalRecord & { seq: number };

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

/** Separator used when composing a synthetic Map key out of several fields
 *  (`deriveTargetKey`'s tab prefix, `summarizeBrowserSignals`'s dedup keys).
 *  A NAMED CONSTANT on purpose — an earlier revision embedded a raw U+0000
 *  byte directly in this file as the separator, which made `file`(1)
 *  classify the source as binary "data", made `grep` skip it by default,
 *  and made the byte invisible in a diff. A named constant keeps the
 *  separator visible in source and in diffs no matter what character it is. */
const KEY_SEP = ' ';

// ── Collector context (platform/appVersion/channel/conversationId/ts) ────

/** `getPlatform()` (utils/platform.ts) logs a console warning on every call
 *  made before `initPlatform()` has resolved at app startup. A signal can
 *  fire many times per second (one per browser tool call), so calling it
 *  uncached would turn one early-startup race into per-call console noise.
 *  Cached after the first non-'unknown' read; re-attempted on every call
 *  while still 'unknown' so a signal built early in startup still recovers
 *  the real platform once `initPlatform()` finishes, without re-warning on
 *  every subsequent call in the steady state. */
let cachedPlatform: string | null = null;

function resolvedPlatform(): string {
  if (cachedPlatform === null || cachedPlatform === 'unknown') {
    try {
      cachedPlatform = getPlatform();
    } catch {
      cachedPlatform = 'unknown';
    }
  }
  return cachedPlatform;
}

/** Single source of truth for the uniform `BrowserSignalContext` every
 *  collection point (registry.ts, previewStore.ts) attaches to its events —
 *  avoids duplicating the `getPlatform()` caching above in each caller. */
export function buildBrowserSignalContext(
  channel: 'builtin' | 'chrome',
  conversationId?: string,
  now: number = Date.now(),
  loopId?: string,
): BrowserSignalContext {
  return {
    platform: resolvedPlatform(),
    appVersion: APP_VERSION,
    channel,
    ...(conversationId ? { conversationId } : {}),
    ...(loopId ? { loopId } : {}),
    ts: now,
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

/** Emit once a streak first crosses the threshold (count===3), then only
 *  every REPEAT_EMIT_STRIDE calls after that ("still stuck" heartbeat)
 *  instead of every single call. A task hammering the same target hundreds
 *  of times previously emitted a `repeat_action` on every one of those
 *  calls once past the threshold, which could flood the whole 5000-entry
 *  rolling buffer (`MAX_BROWSER_SIGNAL_ENTRIES`) with one repetitive signal
 *  and evict everything else from the same task. */
const REPEAT_EMIT_STRIDE = 10;

/** Per-conversation same-tool+same-target consecutive-call counter.
 *  Emits (shouldEmit=true) at count 3, then every `REPEAT_EMIT_STRIDE`
 *  calls after that; resets on any change of tool or target. Caller owns
 *  the instance's lifetime/scoping. */
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
    const shouldEmit = this.count === 3 || (this.count > 3 && (this.count - 3) % REPEAT_EMIT_STRIDE === 0);
    return { count: this.count, shouldEmit };
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

/** Hot-path guard for both `classifyBlockedPage` and `detectFrameHint`:
 *  a browser tool result can be a multi-MB page dump (e.g. `extract_text`
 *  with no selector), and both run on EVERY tool call, success or failure.
 *  A block/challenge banner or an iframe note always appears early in the
 *  text, so scanning only the prefix avoids paying several regexes' worth
 *  of CPU per call against megabytes of text for no detection benefit.
 */
const CLASSIFY_SCAN_CHARS = 2000;

function scanPrefix(resultText: string): string {
  return resultText.length > CLASSIFY_SCAN_CHARS ? resultText.slice(0, CLASSIFY_SCAN_CHARS) : resultText;
}

// Bare "429" false-positives on a price ("$429"), an item count, or a port
// number on an otherwise-successful page — require it to co-occur with
// rate-limit wording within a short span. "too many requests" alone is
// specific enough to stand on its own.
const HTTP_429_PATTERNS = [
  /\b429\b[^.\n]{0,40}(?:too many requests|rate limit)/i,
  /(?:too many requests|rate limit)[^.\n]{0,40}\b429\b/i,
  /too many requests/i,
];
// Bare "cloudflare" false-positives on an ordinary page footer/CDN badge
// ("Powered by Cloudflare") — the other three phrases are already specific
// challenge-page wording and stand on their own; the cloudflare mention only
// counts when paired with actual challenge wording nearby.
const CHALLENGE_PATTERNS = [
  /checking your browser/i,
  /cf-browser-verification/i,
  /just a moment/i,
  /cloudflare[^.\n]{0,80}challenge/i,
  /challenge[^.\n]{0,80}cloudflare/i,
];
const VERIFY_WALL_PATTERNS = [/verify you are human/i, /complete the captcha/i, /security check/i, /verify[^.]{0,20}robot/i];

/** Conservative, keyword-based classifier — "宁漏勿误报" (prefer a missed
 *  detection over a false positive). Only meaningful on a FAILED tool_call
 *  (callers gate on `!ok`) — a successful result is not a blocked page no
 *  matter what words its content happens to contain. Never throws. */
export function classifyBlockedPage(resultText: string | undefined | null): 'http_429' | 'challenge' | 'verify_wall' | null {
  if (!resultText) return null;
  try {
    const scanned = scanPrefix(resultText);
    if (HTTP_429_PATTERNS.some((p) => p.test(scanned))) return 'http_429';
    if (CHALLENGE_PATTERNS.some((p) => p.test(scanned))) return 'challenge';
    if (VERIFY_WALL_PATTERNS.some((p) => p.test(scanned))) return 'verify_wall';
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
 *  hidden root cause behind selector-resolution failures). Only meaningful
 *  on a FAILED tool_call (callers gate on `!ok`) — a successful snapshot or
 *  extract routinely contains the bare word "frame" (a `<iframe>` tag in the
 *  DOM tree, a "chart-frame"/"time-frame" class or id, etc.), so this
 *  intentionally requires the literal "iframe" token, not bare "frame". */
export function detectFrameHint(resultText: string | undefined | null): boolean {
  if (!resultText) return false;
  return /\biframe\b/i.test(scanPrefix(resultText));
}

/** This codebase's error-result convention: every failing ToolResult string
 *  (approval denial, execution error, MCP transport error — see
 *  `abu-browser-bridge/src/tools.ts`'s `formatResult`) starts with "Error". */
export function isBrowserToolResultError(resultText: string): boolean {
  return /^\s*error\b/i.test(resultText);
}

// ── deriveTargetKey ───────────────────────────────────────────────────────

/** 32-bit FNV-1a — small, dependency-free, good-enough distribution for a
 *  diagnostics dedup key (not a security hash). Returns 8 lowercase hex
 *  chars. */
function fnv1aHex(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** A `text`/`role`/`name`/`testId` locator strategy would leak literal page
 *  content if serialized verbatim (see the module doc's privacy
 *  constraint), so it is hashed instead of dropped. Hashing — instead of
 *  folding every such locator into one shared 'locator:other' bucket —
 *  keeps repeat-detection and the diagnostic summary's top-3 list accurate:
 *  clicking 3 different buttons that each resolve by visible text no longer
 *  reads as "the same target clicked 3 times", and clicking the same button
 *  3 times is still recognized as a real repeat. The prefix names which
 *  locator strategy was used (for readability); the hash covers the whole
 *  parsed locator object so two different `text` values never collide. */
function hashedLocatorKey(parsed: Record<string, unknown>): string {
  const strategy = typeof parsed.text === 'string' ? 'text'
    : typeof parsed.testId === 'string' ? 'testId'
    : (typeof parsed.role === 'string' || typeof parsed.name === 'string') ? 'role'
    : 'locator';
  return `${strategy}#${fnv1aHex(JSON.stringify(parsed))}`;
}

/** Structural-only locator fingerprint for repeat-action detection.
 *  `ref`/`css`/`xpath`/`selector` are serialized verbatim (structural, not
 *  page content); `text`/`role`/`name`/`testId` locators are hashed (see
 *  `hashedLocatorKey`) instead of serialized, and a fill/select `value` is
 *  never read at all — see the module doc's privacy constraint.
 *
 *  Every key is prefixed with the tab id when one is present: element refs
 *  like "e1" are assigned per-snapshot and routinely reused across
 *  different tabs/pages, so without the tab id two unrelated targets on
 *  different tabs would collide into one (false) repeat-action streak. */
export function deriveTargetKey(toolName: string, input: Record<string, unknown>): string {
  const tabId = input.tabId;
  const tabPrefix = typeof tabId === 'number' || typeof tabId === 'string' ? `tab:${tabId}${KEY_SEP}` : '';

  const rawLocator = input.locator;
  if (typeof rawLocator === 'string') {
    try {
      const parsed = JSON.parse(rawLocator) as Record<string, unknown>;
      if (typeof parsed.ref === 'string') return `${tabPrefix}ref:${parsed.ref}`;
      if (typeof parsed.css === 'string') return `${tabPrefix}css:${parsed.css}`;
      if (typeof parsed.xpath === 'string') return `${tabPrefix}xpath:${parsed.xpath}`;
      return `${tabPrefix}${hashedLocatorKey(parsed)}`;
    } catch {
      return `${tabPrefix}locator:unparsable`;
    }
  }
  if (typeof input.selector === 'string' && input.selector.length > 0) {
    return `${tabPrefix}selector:${input.selector}`;
  }
  if (tabPrefix) return `${tabPrefix}notarget`;
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
let browserSignalBuffer: StoredBrowserSignalRecord[] = [];
let browserSignalWriteIndex = 0;
let browserSignalCount = 0;
/**
 * Process-monotonic signal counter — the "which run produced this" key.
 *
 * Deliberately NOT reset by `clearBrowserSignals()`: a cursor captured before
 * a clear must stay a lower bound afterwards. Resetting would make every
 * surviving record look newer than that cursor and pull a previous run's
 * actions into the next run's report — the exact cross-run bleed the cursor
 * exists to prevent.
 */
let browserSignalSeq = 0;

/**
 * A lower bound on the signals that come next. Capture before a run, pass to
 * `buildBrowserRunReport` as `sinceSeq` after it.
 */
export function getBrowserSignalCursor(): number {
  return browserSignalSeq;
}

/** Never throws — a bad/malformed record is silently dropped. Observability
 *  must never become a reason the app misbehaves. */
export function recordBrowserSignal(record: BrowserSignalRecord): void {
  try {
    if (!record || typeof record !== 'object') return;
    browserSignalSeq++;
    const stored: StoredBrowserSignalRecord = { ...record, seq: browserSignalSeq };
    if (browserSignalCount < MAX_BROWSER_SIGNAL_ENTRIES) {
      browserSignalBuffer.push(stored);
      browserSignalCount++;
    } else {
      browserSignalBuffer[browserSignalWriteIndex] = stored;
    }
    browserSignalWriteIndex = (browserSignalWriteIndex + 1) % MAX_BROWSER_SIGNAL_ENTRIES;
  } catch {
    // Observability must never change product behavior.
  }
}

export function getRecentBrowserSignals(): StoredBrowserSignalRecord[] {
  const total = Math.min(browserSignalCount, MAX_BROWSER_SIGNAL_ENTRIES);
  const start = browserSignalCount < MAX_BROWSER_SIGNAL_ENTRIES ? 0 : browserSignalWriteIndex;
  const result: StoredBrowserSignalRecord[] = [];
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

/** Test utility / conversation teardown: clears one conversation's trackers
 *  (repeat/fallback state AND the tab→origin cache below), or all of them
 *  when no id is given. Wired into `chatStore.ts`'s `deleteConversation` —
 *  the existing per-conversation-module teardown hook (mirrors
 *  `clearInputQueue`/`useTaskExecutionStore.clearConversation` etc. already
 *  called there) — so a long-lived app session doesn't accumulate an
 *  unbounded number of dead conversations' tracker/cache entries. */
export function clearBrowserToolTrackers(conversationId?: string): void {
  if (conversationId) {
    repeatTrackers.delete(conversationId);
    fallbackTrackers.delete(conversationId);
    clearTabOriginCache(conversationId);
    return;
  }
  repeatTrackers.clear();
  fallbackTrackers.clear();
  clearTabOriginCache();
}

// ── Tab → origin cache (zero-extra-round-trip site attribution) ──────────
// `navigate` is the only browser action that carries its destination URL
// directly; every other action only carries a numeric tabId. Resolving that
// tabId to an origin via `get_tabs` just for telemetry would double this
// app's browser traffic (see `recordBrowserToolCallSignal`'s doc), so
// instead the origin a `navigate` call already resolved for FREE is cached
// here and reused by later calls against the same tab — giving
// `bySiteAndPlatform` real site coverage beyond navigate calls alone, at
// zero additional round trips. Scoped by conversationId so two unrelated
// tasks reusing the same numeric tabId never cross-contaminate.
const tabOriginCache = new Map<string, string>();

function tabOriginCacheKey(conversationId: string | undefined, tabId: number): string {
  return `${conversationId ?? NO_CONVERSATION_KEY}${KEY_SEP}${tabId}`;
}

export function noteTabOrigin(conversationId: string | undefined, tabId: number, origin: string): void {
  try {
    tabOriginCache.set(tabOriginCacheKey(conversationId, tabId), origin);
  } catch {
    // Observability must never change product behavior.
  }
}

export function getCachedTabOrigin(conversationId: string | undefined, tabId: number): string | undefined {
  try {
    return tabOriginCache.get(tabOriginCacheKey(conversationId, tabId));
  } catch {
    return undefined;
  }
}

/** Test utility / folded into `clearBrowserToolTrackers` for conversation
 *  teardown — clears one conversation's cached tab origins, or all of them
 *  when no id is given. */
export function clearTabOriginCache(conversationId?: string): void {
  if (conversationId) {
    const prefix = `${conversationId}${KEY_SEP}`;
    for (const key of tabOriginCache.keys()) {
      if (key.startsWith(prefix)) tabOriginCache.delete(key);
    }
    return;
  }
  tabOriginCache.clear();
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

/** No production collection point emits `task_end` yet (see the batch 1
 *  delivery report's "task_end hook" note) — the existing `agentEnd`/
 *  `subagentEnd` lifecycle hooks that could feed it have known gaps on the
 *  error/abort exit paths, and wiring around that gap is a separate,
 *  larger change than this observability-only batch. `taskCount`/
 *  `successRateApprox` are therefore always `0`/`null` in production today;
 *  this flag lets a bundle reader tell "genuinely zero browser tasks" apart
 *  from "the counter isn't wired up yet" instead of silently misreading a
 *  0 as good news. */
export const TASK_END_INSTRUMENTED = false;

/** Embedded in the diagnostic bundle's `browser/summary.json` alongside
 *  `TASK_END_INSTRUMENTED`. Also documents the buffer's actual scope: it is
 *  a plain in-memory ring buffer (see `MAX_BROWSER_SIGNAL_ENTRIES` above),
 *  reset on every app restart — cross-restart persistence is a later
 *  batch's decision, not this one's. */
export const BROWSER_SIGNALS_SCOPE_NOTE =
  'taskCount/successRateApprox are 0/null in this build because no production code path ' +
  'emits the task_end signal yet (see TASK_END_INSTRUMENTED) — this is not necessarily zero ' +
  'browser task activity. All figures in this section cover only the CURRENT app session: ' +
  'signals live in an in-memory ring buffer and are lost on restart (disk persistence across ' +
  'restarts is deferred to a later batch).';

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
    const key = `${record.tool}${KEY_SEP}${record.targetKey}`;
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
    const key = `${origin}${KEY_SEP}${platform}`;
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
