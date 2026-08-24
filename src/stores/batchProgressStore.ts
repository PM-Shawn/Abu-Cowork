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
  getTerminalSummary: (identity: BatchIdentity) => BatchTerminalSummary | undefined;
}

type BatchProgressStore = BatchProgressState & BatchProgressActions;

/** Keep a completed batch inspectable in its original session without retaining it forever. */
export const BATCH_PROGRESS_COMPLETED_TTL_MS = 5 * 60 * 1000;
/** Bound transient renderer memory while retaining normal screenshots and useful text. */
export const BATCH_PROGRESS_MAX_RESULT_CHARS = 20_000;
export const BATCH_PROGRESS_MAX_RICH_CONTENT_BYTES = 16 * 1024 * 1024;
export const BATCH_PROGRESS_GLOBAL_RICH_CONTENT_BYTES = 32 * 1024 * 1024;
export const BATCH_PROGRESS_MAX_STEPS_PER_TASK = 64;

function keyOf(identity: BatchIdentity): string {
  return makeBatchKey(identity);
}

const textEncoder = new TextEncoder();
const fatalTextDecoder = new TextDecoder('utf-8', { fatal: true });

function utf8ByteLength(text: string): number {
  return textEncoder.encode(text).byteLength;
}

function truncateUtf8ToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  // A valid UTF-8 prefix cannot require more UTF-16 code units than its byte
  // cap. Slice before encoding so hostile multi-hundred-MiB text blocks do not
  // force an unbounded renderer allocation just to retain the first 16 MiB.
  const boundedPrefix = text.length > maxBytes + 1 ? text.slice(0, maxBytes + 1) : text;
  const encoded = textEncoder.encode(boundedPrefix);
  if (encoded.byteLength <= maxBytes) return text;
  for (let end = maxBytes; end >= Math.max(0, maxBytes - 3); end--) {
    try {
      return fatalTextDecoder.decode(encoded.subarray(0, end));
    } catch {
      // Back up at most one UTF-8 code point (4 bytes total) until the prefix
      // ends on a valid boundary. This avoids per-code-point encoding on large
      // near-boundary payloads while guaranteeing no dangling surrogate/emoji.
    }
  }
  return '';
}

function richContentBytes(content: ToolResultContent[] | undefined): number {
  return content?.reduce((total, block) =>
    total + (block.type === 'image' ? block.source.data.length : utf8ByteLength(block.text)), 0) ?? 0;
}

function batchRichContentBytes(entry: BatchEntry): number {
  return entry.tasks.reduce((batchTotal, task) =>
    batchTotal + task.steps.reduce((taskTotal, step) =>
      taskTotal + richContentBytes(step.resultContent), 0), 0);
}

interface RetainedBatchResultContent {
  content?: ToolResultContent[];
  state?: BatchTaskStepRichContentState;
}

function retainBatchResultContentWithState(
  content: ToolResultContent[] | undefined,
  availableBytes: number,
): RetainedBatchResultContent {
  if (!content || content.length === 0) return {};
  if (availableBytes <= 0) {
    return content.some((block) =>
      block.type === 'image' ? block.source.data.length > 0 : block.text.length > 0)
      ? { state: 'partially-retained' }
      : {};
  }
  let remaining = availableBytes;
  const retained: ToolResultContent[] = [];
  let omitted = false;
  let sawRich = false;
  for (const block of content) {
    if (block.type === 'image') {
      const bytes = block.source.data.length;
      if (bytes <= 0) continue;
      sawRich = true;
      if (bytes > remaining) {
        omitted = true;
        continue;
      }
      retained.push(block);
      remaining -= bytes;
      continue;
    }
    if (block.text.length <= 0) continue;
    sawRich = true;
    if (remaining <= 0) {
      omitted = true;
      continue;
    }
    const bytes = block.text.length > remaining ? remaining + 1 : utf8ByteLength(block.text);
    const text = truncateUtf8ToBytes(block.text, remaining);
    if (text) retained.push({ type: 'text', text });
    const retainedBytes = utf8ByteLength(text);
    remaining -= retainedBytes;
    if (retainedBytes < bytes) omitted = true;
  }
  if (!sawRich) return {};
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

function totalRetainedRichBytes(batches: Record<string, BatchEntry>): number {
  return Object.values(batches).reduce((total, entry) => total + entry.retainedRichBytes, 0);
}

function refreshDiagnostics(state: BatchProgressState): void {
  const total = totalRetainedRichBytes(state.batches);
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
          const availableRichBytes = Math.max(
            0,
            BATCH_PROGRESS_MAX_RICH_CONTENT_BYTES
              - (batchRichContentBytes(entry) - richContentBytes(step.resultContent)),
          );
          const retention = retainBatchResultContentWithState(result.resultContent, availableRichBytes);
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
        const retention = retainBatchResultContentWithState(result.resultContent, availableRichBytes);
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
