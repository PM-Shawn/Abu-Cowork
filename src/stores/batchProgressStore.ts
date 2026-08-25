/**
 * Batch progress store — ephemeral UI state for run_agent_batch live progress.
 *
 * EPHEMERAL: no persist middleware. This is transient UI state that doesn't
 * survive page reloads. Intentional — in-flight batches can't be resumed anyway.
 */
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type {
  BatchIdentity,
  BatchTaskTerminalReason,
  BatchTaskTerminalStatus,
  BatchTerminalSummary,
  TokenUsage,
  ToolResultContent,
} from '@/types';
import { makeBatchKey } from '@/types';

export type BatchTaskStatus = 'queued' | 'running' | BatchTaskTerminalStatus;
export type BatchTaskStepStatus = 'running' | 'completed' | 'error' | 'cancelled';
export type BatchTaskStepRichContentState = 'retained' | 'partially-retained' | 'released';

/** One child tool call retained while a batch card is still live. */
export interface BatchTaskStep {
  id: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  result?: string;
  /** Raw rich blocks are intentionally ephemeral; DetailBlockView consumes image blocks directly. */
  resultContent?: ToolResultContent[];
  /** Explicit marker so UI can localize a deterministic fallback after LRU releases rich blocks. */
  richContentState?: BatchTaskStepRichContentState;
  status: BatchTaskStepStatus;
  startTime: number;
  endTime?: number;
}

export interface BatchTaskProgress {
  label: string;
  status: BatchTaskStatus;
  terminalReason?: BatchTaskTerminalReason;
  activity?: string;
  turn?: number;
  startedAt?: number;
  endedAt?: number;
  toolCallCount: number;
  lastToolName?: string;
  tokenUsage?: TokenUsage;
  steps: BatchTaskStep[];
}

export interface BatchEntry {
  identity: BatchIdentity;
  startedAt: number;
  tasks: BatchTaskProgress[];
  runLeaseCount: number;
  viewLeaseCount: number;
  retainedRichBytes: number;
  lastRichAccessTick: number;
}

export interface BatchRichContentDiagnostics {
  totalRetainedRichBytes: number;
  retainedRichBytesCap: number;
  overageBytes: number;
  evictionCount: number;
  releasedBatchCount: number;
  lastEvictedKey?: string;
}

interface BatchProgressState {
  batches: Record<string, BatchEntry>;
  activeVisibleBatchKey?: string;
  richAccessClock: number;
  richContentDiagnostics: BatchRichContentDiagnostics;
}

interface BatchProgressActions {
  initBatch: (identity: BatchIdentity, labels: string[]) => void;
  setTaskRunning: (identity: BatchIdentity, idx: number) => void;
  setTaskActivity: (identity: BatchIdentity, idx: number, activity: string, turn?: number) => void;
  startTaskStep: (identity: BatchIdentity, idx: number, step: Pick<BatchTaskStep, 'id' | 'toolName' | 'toolInput'>) => void;
  finishTaskStep: (
    identity: BatchIdentity,
    idx: number,
    result: Pick<BatchTaskStep, 'id' | 'toolName' | 'result' | 'resultContent'> & { error: boolean },
  ) => void;
  setTaskTokenUsage: (identity: BatchIdentity, idx: number, tokenUsage: TokenUsage) => void;
  setTaskFinalStats: (
    identity: BatchIdentity,
    idx: number,
    stats: { toolCallCount: number; tokenUsage: TokenUsage },
  ) => void;
  setTaskTerminal: (
    identity: BatchIdentity,
    idx: number,
    terminal: { status: BatchTaskTerminalStatus; reason: BatchTaskTerminalReason },
  ) => BatchTerminalSummary | undefined;
  acquireViewLease: (identity: BatchIdentity) => void;
  releaseViewLease: (identity: BatchIdentity) => void;
  setActiveVisibleBatch: (identity: BatchIdentity | undefined) => void;
  releaseBatchRichContent: (identity: BatchIdentity) => void;
  scheduleClearBatch: (identity: BatchIdentity, delayMs: number) => void;
  cancelScheduledClear: (identity: BatchIdentity) => void;
  clearBatch: (identity: BatchIdentity) => void;
  clearConversation: (conversationId: string) => void;
  getTerminalSummary: (identity: BatchIdentity) => BatchTerminalSummary | undefined;
}

type BatchProgressStore = BatchProgressState & BatchProgressActions;

/** Keep a completed batch inspectable in its original session without retaining it forever. */
export const BATCH_PROGRESS_COMPLETED_TTL_MS = 5 * 60 * 1000;
/** Bound transient renderer memory while retaining normal screenshots and useful text. */
export const BATCH_PROGRESS_MAX_RESULT_CHARS = 20_000;
export const BATCH_PROGRESS_MAX_RICH_CONTENT_BYTES = 16 * 1024 * 1024;
export const BATCH_PROGRESS_GLOBAL_RICH_CONTENT_BYTES = 32 * 1024 * 1024;
export const BATCH_PROGRESS_MAX_RICH_CONTENT_BLOCKS = 64;
export const BATCH_PROGRESS_MAX_RICH_CONTENT_BLOCK_BYTES = BATCH_PROGRESS_MAX_RICH_CONTENT_BYTES;
export const BATCH_PROGRESS_MAX_STEPS_PER_TASK = 64;

function keyOf(identity: BatchIdentity): string {
  return makeBatchKey(identity);
}

const textEncoder = new TextEncoder();
const TEXT_BLOCK_JSON_ENVELOPE_BYTES = textEncoder.encode(JSON.stringify({ type: 'text', text: '' })).byteLength;
const IMAGE_BLOCK_JSON_ENVELOPE_BYTES = textEncoder.encode(JSON.stringify({
  type: 'image',
  source: { type: 'base64', media_type: '', data: '' },
})).byteLength;
const RESULT_CONTENT_ARRAY_ENVELOPE_BYTES = 2;
const JSON_SAFE_ASCII = /^[\x20-\x21\x23-\x5b\x5d-\x7e]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isBase64Like(value: string): boolean {
  if (value.length === 0 || value.length > BATCH_PROGRESS_MAX_RICH_CONTENT_BLOCK_BYTES) return false;
  // Accept standard and URL-safe alphabets with optional terminal padding.
  // Reject whitespace/control/Unicode and impossible one-character tails.
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return false;
  const paddingLength = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length - paddingLength) % 4 !== 1;
}

function isImageMediaType(value: string): boolean {
  return value.length <= 255 && /^image\/[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(value);
}

/** Exact UTF-8 bytes produced inside a JSON string, without materializing a
 * second attacker-sized JSON copy. This accounts for JSON escapes and treats a
 * surrogate pair atomically so retained text never ends on half an emoji. */
function jsonStringContentBytes(text: string, maxBytes = Number.POSITIVE_INFINITY): { bytes: number; end: number } {
  const safeAsciiLimit = Number.isFinite(maxBytes)
    ? Math.max(0, Math.min(text.length, Math.floor(maxBytes)))
    : text.length;
  const safeAsciiCandidate = safeAsciiLimit === text.length
    ? text
    : text.slice(0, safeAsciiLimit);
  if (JSON_SAFE_ASCII.test(safeAsciiCandidate)) {
    return { bytes: safeAsciiLimit, end: safeAsciiLimit };
  }

  let bytes = 0;
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    let codeUnits = 1;
    let nextBytes: number;
    if (code === 0x22 || code === 0x5c) {
      nextBytes = 2;
    } else if (code <= 0x1f) {
      nextBytes = code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        codeUnits = 2;
        nextBytes = 4;
      } else {
        // Well-formed JSON.stringify escapes lone surrogates as \udxxx.
        nextBytes = 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      nextBytes = 6;
    } else if (code <= 0x7f) {
      nextBytes = 1;
    } else if (code <= 0x7ff) {
      nextBytes = 2;
    } else {
      nextBytes = 3;
    }
    if (bytes + nextBytes > maxBytes) break;
    bytes += nextBytes;
    index += codeUnits;
  }
  return { bytes, end: index };
}

function richContentBlockBytes(block: ToolResultContent): number {
  if (block.type === 'text') {
    return TEXT_BLOCK_JSON_ENVELOPE_BYTES + jsonStringContentBytes(block.text).bytes;
  }
  // Admission restricts both strings to JSON-safe ASCII, so their exact JSON
  // UTF-8 contribution is their code-unit length with no escaping expansion.
  return IMAGE_BLOCK_JSON_ENVELOPE_BYTES
    + block.source.media_type.length
    + block.source.data.length;
}

function richContentBytes(content: ToolResultContent[] | undefined): number {
  if (!content || content.length === 0) return 0;
  return RESULT_CONTENT_ARRAY_ENVELOPE_BYTES
    + content.reduce((total, block, index) =>
      total + richContentBlockBytes(block) + (index > 0 ? 1 : 0), 0);
}

function richContentBlockCount(content: ToolResultContent[] | undefined): number {
  return content?.length ?? 0;
}

function batchRichContentBytes(entry: BatchEntry): number {
  return entry.tasks.reduce((batchTotal, task) =>
    batchTotal + task.steps.reduce((taskTotal, step) =>
      taskTotal + richContentBytes(step.resultContent), 0), 0);
}

function batchRichContentBlockCount(entry: BatchEntry): number {
  return entry.tasks.reduce((batchTotal, task) =>
    batchTotal + task.steps.reduce((taskTotal, step) =>
      taskTotal + richContentBlockCount(step.resultContent), 0), 0);
}

interface RetainedBatchResultContent {
  content?: ToolResultContent[];
  state?: BatchTaskStepRichContentState;
}

function retainBatchResultContentWithState(
  content: unknown,
  availableBytes: number,
  availableBlocks = BATCH_PROGRESS_MAX_RICH_CONTENT_BLOCKS,
): RetainedBatchResultContent {
  if (content === undefined) return {};
  if (!Array.isArray(content)) return { state: 'partially-retained' };
  if (content.length === 0) return {};
  const byteBudget = Number.isFinite(availableBytes)
    ? Math.max(0, Math.min(BATCH_PROGRESS_MAX_RICH_CONTENT_BYTES, Math.floor(availableBytes)))
    : 0;
  const blockBudget = Number.isFinite(availableBlocks)
    ? Math.max(0, Math.min(BATCH_PROGRESS_MAX_RICH_CONTENT_BLOCKS, Math.floor(availableBlocks)))
    : 0;
  const scanLimit = Math.min(content.length, BATCH_PROGRESS_MAX_RICH_CONTENT_BLOCKS);
  const retained: ToolResultContent[] = [];
  let retainedBytes = RESULT_CONTENT_ARRAY_ENVELOPE_BYTES;
  let omitted = content.length > scanLimit;
  let sawRich = false;
  for (let index = 0; index < scanLimit; index++) {
    if (retained.length >= blockBudget) {
      omitted = true;
      break;
    }
    const rawBlock = content[index] as unknown;
    if (!isRecord(rawBlock) || typeof rawBlock.type !== 'string') {
      sawRich = true;
      omitted = true;
      continue;
    }
    const commaBytes = retained.length > 0 ? 1 : 0;
    const availableForBlock = Math.max(0, byteBudget - retainedBytes - commaBytes);
    const maxBlockBytes = Math.min(BATCH_PROGRESS_MAX_RICH_CONTENT_BLOCK_BYTES, availableForBlock);
    if (rawBlock.type === 'image') {
      const source = rawBlock.source;
      if (!isRecord(source)
        || source.type !== 'base64'
        || typeof source.media_type !== 'string'
        || !isImageMediaType(source.media_type)
        || typeof source.data !== 'string') {
        sawRich = true;
        omitted = true;
        continue;
      }
      if (source.data.length === 0) continue;
      sawRich = true;
      if (!isBase64Like(source.data)) {
        omitted = true;
        continue;
      }
      const candidate: ToolResultContent = {
        type: 'image',
        source: { type: 'base64', media_type: source.media_type, data: source.data },
      };
      const candidateBytes = richContentBlockBytes(candidate);
      if (candidateBytes > maxBlockBytes) {
        omitted = true;
        continue;
      }
      retained.push(candidate);
      retainedBytes += candidateBytes + commaBytes;
      continue;
    }
    if (rawBlock.type !== 'text' || typeof rawBlock.text !== 'string') {
      sawRich = true;
      omitted = true;
      continue;
    }
    if (rawBlock.text.length === 0) continue;
    sawRich = true;
    const textBudget = maxBlockBytes - TEXT_BLOCK_JSON_ENVELOPE_BYTES;
    if (textBudget <= 0) {
      omitted = true;
      continue;
    }
    const fitted = jsonStringContentBytes(rawBlock.text, textBudget);
    if (fitted.end === 0) {
      omitted = true;
      continue;
    }
    const text = fitted.end === rawBlock.text.length ? rawBlock.text : rawBlock.text.slice(0, fitted.end);
    const candidate: ToolResultContent = { type: 'text', text };
    const candidateBytes = richContentBlockBytes(candidate);
    if (candidateBytes > maxBlockBytes) {
      omitted = true;
      continue;
    }
    retained.push(candidate);
    retainedBytes += candidateBytes + commaBytes;
    if (fitted.end < rawBlock.text.length) omitted = true;
  }
  if (!sawRich) return omitted ? { state: 'partially-retained' } : {};
  return {
    content: retained.length > 0 ? retained : undefined,
    state: omitted ? 'partially-retained' : retained.length > 0 ? 'retained' : undefined,
  };
}

export function retainBatchResultContent(
  content: ToolResultContent[] | undefined,
  availableBytes: number,
): ToolResultContent[] | undefined {
  return retainBatchResultContentWithState(content, availableBytes).content;
}

function truncateBatchResult(result: string | undefined): string | undefined {
  if (!result || result.length <= BATCH_PROGRESS_MAX_RESULT_CHARS) return result;
  return `${result.slice(0, BATCH_PROGRESS_MAX_RESULT_CHARS)}\n…`;
}

function isTerminalStatus(status: BatchTaskStatus): status is BatchTaskTerminalStatus {
  return status === 'succeeded' || status === 'failed' || status === 'stopped' || status === 'incomplete';
}

function isSettledStatus(status: BatchTaskStatus): boolean {
  return isTerminalStatus(status);
}

function allTasksTerminal(entry: BatchEntry): boolean {
  return entry.tasks.every((task) => isSettledStatus(task.status));
}

export function buildBatchTerminalSummary(entry: BatchEntry): BatchTerminalSummary | undefined {
  const counts: Record<BatchTaskTerminalStatus, number> = {
    succeeded: 0,
    failed: 0,
    stopped: 0,
    incomplete: 0,
  };
  const tasks = entry.tasks.flatMap((task, taskIndex) => {
    if (!isTerminalStatus(task.status)) return [];
    const status = task.status;
    const terminalReason = task.terminalReason ?? 'error';
    counts[status]++;
    return [{ taskIndex, status, terminalReason }];
  });
  if (tasks.length === 0) return undefined;
  return {
    version: 1,
    batch: entry.identity,
    taskCount: entry.tasks.length,
    counts,
    tasks,
  };
}

/**
 * Preserve active work when the ephemeral timeline reaches its cap. Terminal
 * evidence is replaceable; a running step is not, otherwise its later
 * tool-end can no longer be reconciled with what the user saw start.
 */
function makeRoomForStep(task: BatchTaskProgress): boolean {
  if (task.steps.length < BATCH_PROGRESS_MAX_STEPS_PER_TASK) return true;
  const terminalStepIndex = task.steps.findIndex((step) => step.status !== 'running');
  if (terminalStepIndex === -1) return false;
  task.steps.splice(terminalStepIndex, 1);
  return true;
}

const clearTimers = new Map<string, ReturnType<typeof setTimeout>>();
/**
 * The step timeline is deliberately capped at 64 entries, so it cannot also
 * serve as the source of truth for whether a tool call has already been
 * counted. This short-lived ledger lasts only for the live batch and is
 * discarded with it; it prevents a late/repeated tool-end from inflating the
 * user-facing count after its start was not retained in the timeline.
 */
const observedStepIds = new Map<string, Set<string>>();

function getObservedStepIds(batchKey: string): Set<string> {
  let ids = observedStepIds.get(batchKey);
  if (!ids) {
    ids = new Set<string>();
    observedStepIds.set(batchKey, ids);
  }
  return ids;
}

function cancelClearTimer(batchKey: string): void {
  const timer = clearTimers.get(batchKey);
  if (timer !== undefined) {
    clearTimeout(timer);
    clearTimers.delete(batchKey);
  }
}

function canClearEntry(entry: BatchEntry | undefined): boolean {
  return !!entry && allTasksTerminal(entry) && entry.runLeaseCount === 0 && entry.viewLeaseCount === 0;
}

function emptyDiagnostics(): BatchRichContentDiagnostics {
  return {
    totalRetainedRichBytes: 0,
    retainedRichBytesCap: BATCH_PROGRESS_GLOBAL_RICH_CONTENT_BYTES,
    overageBytes: 0,
    evictionCount: 0,
    releasedBatchCount: 0,
  };
}

function refreshDiagnostics(state: BatchProgressState): void {
  let total = 0;
  for (const entry of Object.values(state.batches)) {
    // Re-derive from the retained canonical blocks so admission, diagnostics,
    // and LRU all use one exact JSON UTF-8 accounting path.
    entry.retainedRichBytes = batchRichContentBytes(entry);
    total += entry.retainedRichBytes;
  }
  state.richContentDiagnostics.totalRetainedRichBytes = total;
  state.richContentDiagnostics.retainedRichBytesCap = BATCH_PROGRESS_GLOBAL_RICH_CONTENT_BYTES;
  state.richContentDiagnostics.overageBytes = Math.max(0, total - BATCH_PROGRESS_GLOBAL_RICH_CONTENT_BYTES);
}

function releaseRichBlocks(entry: BatchEntry): boolean {
  let released = false;
  for (const task of entry.tasks) {
    for (const step of task.steps) {
      if (!step.resultContent && step.richContentState !== 'retained' && step.richContentState !== 'partially-retained') {
        continue;
      }
      step.resultContent = undefined;
      step.richContentState = 'released';
      released = true;
    }
  }
  entry.retainedRichBytes = 0;
  return released;
}

function reclaimRichContent(state: BatchProgressState): void {
  refreshDiagnostics(state);
  while (state.richContentDiagnostics.totalRetainedRichBytes > BATCH_PROGRESS_GLOBAL_RICH_CONTENT_BYTES) {
    const candidates = Object.entries(state.batches)
      .filter(([batchKey, entry]) =>
        batchKey !== state.activeVisibleBatchKey
        && entry.retainedRichBytes > 0
        && allTasksTerminal(entry))
      .sort(([aKey, a], [bKey, b]) =>
        a.lastRichAccessTick - b.lastRichAccessTick || aKey.localeCompare(bKey));
    const candidate = candidates[0];
    if (!candidate) break;
    const [batchKey, entry] = candidate;
    if (!releaseRichBlocks(entry)) break;
    state.richContentDiagnostics.evictionCount++;
    state.richContentDiagnostics.releasedBatchCount++;
    state.richContentDiagnostics.lastEvictedKey = batchKey;
    refreshDiagnostics(state);
  }
  refreshDiagnostics(state);
}

function touchRichEntry(state: BatchProgressState, entry: BatchEntry): void {
  state.richAccessClock++;
  entry.lastRichAccessTick = state.richAccessClock;
}

export const useBatchProgressStore = create<BatchProgressStore>()(
  immer((set, get) => ({
    batches: {},
    activeVisibleBatchKey: undefined,
    richAccessClock: 0,
    richContentDiagnostics: emptyDiagnostics(),

    initBatch: (identity, labels) => {
      const batchKey = keyOf(identity);
      cancelClearTimer(batchKey);
      observedStepIds.delete(batchKey);
      set((state) => {
        state.batches[batchKey] = {
          identity,
          startedAt: Date.now(),
          runLeaseCount: 1,
          viewLeaseCount: 0,
          retainedRichBytes: 0,
          lastRichAccessTick: 0,
          tasks: labels.map((label) => ({ label, status: 'queued', toolCallCount: 0, steps: [] })),
        };
        refreshDiagnostics(state);
      });
    },

    setTaskRunning: (identity, idx) => {
      const batchKey = keyOf(identity);
      cancelClearTimer(batchKey);
      set((state) => {
        const task = state.batches[batchKey]?.tasks[idx];
        if (!task || isSettledStatus(task.status)) return;
        task.status = 'running';
        task.startedAt ??= Date.now();
      });
    },

    setTaskActivity: (identity, idx, activity, turn?) => {
      set((state) => {
        const task = state.batches[keyOf(identity)]?.tasks[idx];
        if (!task || isSettledStatus(task.status)) return;
        task.activity = activity;
        if (turn !== undefined) task.turn = turn;
      });
    },

    startTaskStep: (identity, idx, step) => {
      const batchKey = keyOf(identity);
      cancelClearTimer(batchKey);
      set((state) => {
        const task = state.batches[batchKey]?.tasks[idx];
        if (!task || isSettledStatus(task.status)) return;
        task.status = 'running';
        task.startedAt ??= Date.now();
        const observedIds = getObservedStepIds(batchKey);
        const observedId = `${idx}:${step.id}`;
        if (observedIds.has(observedId)) return;
        observedIds.add(observedId);
        task.toolCallCount++;
        task.lastToolName = step.toolName;
        if (!makeRoomForStep(task)) return;
        task.steps.push({ ...step, status: 'running', startTime: Date.now() });
        const entry = state.batches[batchKey];
        if (entry) {
          entry.retainedRichBytes = batchRichContentBytes(entry);
          reclaimRichContent(state);
        }
      });
    },

    finishTaskStep: (identity, idx, result) => {
      const batchKey = keyOf(identity);
      set((state) => {
        const entry = state.batches[batchKey];
        const task = entry?.tasks[idx];
        if (!entry || !task) return;
        if (isSettledStatus(task.status)) return;
        const now = Date.now();
        const step = task.steps.find((existing) => existing.id === result.id);
        if (step) {
          const existingRichBytes = richContentBytes(step.resultContent);
          const existingRichBlocks = richContentBlockCount(step.resultContent);
          const availableRichBytes = Math.max(
            0,
            BATCH_PROGRESS_MAX_RICH_CONTENT_BYTES
              - (batchRichContentBytes(entry) - existingRichBytes),
          );
          const availableRichBlocks = Math.max(
            0,
            BATCH_PROGRESS_MAX_RICH_CONTENT_BLOCKS
              - (batchRichContentBlockCount(entry) - existingRichBlocks),
          );
          const retention = retainBatchResultContentWithState(
            result.resultContent,
            availableRichBytes,
            availableRichBlocks,
          );
          step.result = truncateBatchResult(result.result);
          step.resultContent = retention.content;
          step.richContentState = retention.state;
          step.status = result.error ? 'error' : 'completed';
          step.endTime = now;
          task.lastToolName = step.toolName;
          entry.retainedRichBytes = batchRichContentBytes(entry);
          if (retention.content) touchRichEntry(state, entry);
          reclaimRichContent(state);
          return;
        }

        // A malformed/late transport must not silently lose a rich result.
        // The normal sidecar order is start -> end; this fallback is only for
        // resilience and deliberately keeps the unknown input empty.
        const observedIds = getObservedStepIds(batchKey);
        const observedId = `${idx}:${result.id}`;
        if (!observedIds.has(observedId)) {
          observedIds.add(observedId);
          task.toolCallCount++;
        }
        task.lastToolName = result.toolName;
        if (!makeRoomForStep(task)) return;
        const availableRichBytes = Math.max(
          0,
          BATCH_PROGRESS_MAX_RICH_CONTENT_BYTES - batchRichContentBytes(entry),
        );
        const availableRichBlocks = Math.max(
          0,
          BATCH_PROGRESS_MAX_RICH_CONTENT_BLOCKS - batchRichContentBlockCount(entry),
        );
        const retention = retainBatchResultContentWithState(
          result.resultContent,
          availableRichBytes,
          availableRichBlocks,
        );
        task.steps.push({
          id: result.id,
          toolName: result.toolName,
          toolInput: {},
          result: truncateBatchResult(result.result),
          resultContent: retention.content,
          richContentState: retention.state,
          status: result.error ? 'error' : 'completed',
          startTime: now,
          endTime: now,
        });
        entry.retainedRichBytes = batchRichContentBytes(entry);
        if (retention.content) touchRichEntry(state, entry);
        reclaimRichContent(state);
      });
    },

    setTaskTokenUsage: (identity, idx, tokenUsage) => {
      set((state) => {
        const task = state.batches[keyOf(identity)]?.tasks[idx];
        if (!task || isSettledStatus(task.status)) return;
        task.tokenUsage = tokenUsage;
      });
    },

    setTaskFinalStats: (identity, idx, stats) => {
      set((state) => {
        const task = state.batches[keyOf(identity)]?.tasks[idx];
        if (!task) return;
        // Progress events keep the live UI current. The terminal result is
        // authoritative for final usage because a direct-answer final turn
        // has no turn-complete callback. Never shrink a count already proven
        // by retained step events.
        task.toolCallCount = Math.max(task.toolCallCount, stats.toolCallCount);
        task.tokenUsage = stats.tokenUsage;
      });
    },

    setTaskTerminal: (identity, idx, terminal) => {
      const batchKey = keyOf(identity);
      let shouldScheduleClear = false;
      set((state) => {
        const entry = state.batches[batchKey];
        const task = entry?.tasks[idx];
        if (!entry || !task || isSettledStatus(task.status)) return;
        const now = Date.now();
        const wasQueued = task.status === 'queued';
        task.status = terminal.status;
        task.terminalReason = terminal.reason;
        task.activity = undefined;
        if (!(wasQueued && terminal.status === 'stopped')) task.startedAt ??= now;
        task.endedAt = now;
        for (const step of task.steps) {
          if (step.status !== 'running') continue;
          // Incomplete means the agent hit its turn budget; without an actual
          // tool error, keep the in-flight child step non-error. Stopped is a
          // user/parent cancellation and gets its own step state.
          step.status = terminal.status === 'failed'
            ? 'error'
            : terminal.status === 'stopped'
              ? 'cancelled'
              : 'completed';
          step.endTime = now;
        }
        if (allTasksTerminal(entry)) {
          entry.runLeaseCount = 0;
          shouldScheduleClear = true;
        }
        entry.retainedRichBytes = batchRichContentBytes(entry);
        reclaimRichContent(state);
      });
      const summary = get().getTerminalSummary(identity);
      if (shouldScheduleClear) {
        get().scheduleClearBatch(identity, BATCH_PROGRESS_COMPLETED_TTL_MS);
      }
      return summary;
    },

    acquireViewLease: (identity) => {
      const batchKey = keyOf(identity);
      cancelClearTimer(batchKey);
      set((state) => {
        const entry = state.batches[batchKey];
        if (!entry) return;
        entry.viewLeaseCount++;
        reclaimRichContent(state);
      });
    },

    releaseViewLease: (identity) => {
      const batchKey = keyOf(identity);
      let shouldScheduleClear = false;
      set((state) => {
        const entry = state.batches[batchKey];
        if (!entry) return;
        entry.viewLeaseCount = Math.max(0, entry.viewLeaseCount - 1);
        shouldScheduleClear = canClearEntry(entry);
        reclaimRichContent(state);
      });
      if (shouldScheduleClear) get().scheduleClearBatch(identity, BATCH_PROGRESS_COMPLETED_TTL_MS);
    },

    setActiveVisibleBatch: (identity) => {
      const batchKey = identity ? keyOf(identity) : undefined;
      set((state) => {
        state.activeVisibleBatchKey = batchKey;
        if (batchKey) {
          const entry = state.batches[batchKey];
          if (entry) touchRichEntry(state, entry);
        }
        reclaimRichContent(state);
      });
    },

    releaseBatchRichContent: (identity) => {
      const batchKey = keyOf(identity);
      set((state) => {
        const entry = state.batches[batchKey];
        if (!entry || !allTasksTerminal(entry) || state.activeVisibleBatchKey === batchKey) return;
        if (releaseRichBlocks(entry)) {
          state.richContentDiagnostics.releasedBatchCount++;
          state.richContentDiagnostics.lastEvictedKey = batchKey;
        }
        reclaimRichContent(state);
      });
    },

    scheduleClearBatch: (identity, delayMs) => {
      const batchKey = keyOf(identity);
      if (!canClearEntry(get().batches[batchKey])) return;
      cancelClearTimer(batchKey);
      clearTimers.set(batchKey, setTimeout(() => {
        clearTimers.delete(batchKey);
        if (canClearEntry(get().batches[batchKey])) {
          get().clearBatch(identity);
        }
      }, delayMs));
    },

    cancelScheduledClear: (identity) => {
      cancelClearTimer(keyOf(identity));
    },

    clearBatch: (identity) => {
      const batchKey = keyOf(identity);
      cancelClearTimer(batchKey);
      observedStepIds.delete(batchKey);
      set((state) => {
        delete state.batches[batchKey];
        if (state.activeVisibleBatchKey === batchKey) state.activeVisibleBatchKey = undefined;
        refreshDiagnostics(state);
      });
    },

    clearConversation: (conversationId) => {
      const identities = Object.values(get().batches)
        .filter((entry) => entry.identity.conversationId === conversationId)
        .map((entry) => entry.identity);
      for (const identity of identities) get().clearBatch(identity);
    },

    getTerminalSummary: (identity) => {
      const entry = get().batches[keyOf(identity)];
      return entry ? buildBatchTerminalSummary(entry) : undefined;
    },
  }))
);

/** Selector hook — returns the batch entry for a given identity, or undefined. */
export function useBatchProgress(identity: BatchIdentity): BatchEntry | undefined {
  return useBatchProgressStore((s) => s.batches[keyOf(identity)]);
}
