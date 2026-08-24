/**
 * Batch progress store — ephemeral UI state for run_agent_batch live progress.
 *
 * EPHEMERAL: no persist middleware. This is transient UI state that doesn't
 * survive page reloads. Intentional — in-flight batches can't be resumed anyway.
 */
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { TokenUsage, ToolResultContent } from '@/types';

export type BatchTaskStatus = 'queued' | 'running' | 'done' | 'error';
export type BatchTaskStepStatus = 'running' | 'completed' | 'error';

/** One child tool call retained while a batch card is still live. */
export interface BatchTaskStep {
  id: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  result?: string;
  /** Raw rich blocks are intentionally ephemeral; DetailBlockView consumes image blocks directly. */
  resultContent?: ToolResultContent[];
  status: BatchTaskStepStatus;
  startTime: number;
  endTime?: number;
}

export interface BatchTaskProgress {
  label: string;
  status: BatchTaskStatus;
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
  startedAt: number;
  tasks: BatchTaskProgress[];
}

interface BatchProgressState {
  batches: Record<string, BatchEntry>;
}

interface BatchProgressActions {
  initBatch: (toolCallId: string, labels: string[]) => void;
  setTaskRunning: (toolCallId: string, idx: number) => void;
  setTaskActivity: (toolCallId: string, idx: number, activity: string, turn?: number) => void;
  startTaskStep: (toolCallId: string, idx: number, step: Pick<BatchTaskStep, 'id' | 'toolName' | 'toolInput'>) => void;
  finishTaskStep: (
    toolCallId: string,
    idx: number,
    result: Pick<BatchTaskStep, 'id' | 'toolName' | 'result' | 'resultContent'> & { error: boolean },
  ) => void;
  setTaskTokenUsage: (toolCallId: string, idx: number, tokenUsage: TokenUsage) => void;
  setTaskFinalStats: (
    toolCallId: string,
    idx: number,
    stats: { toolCallCount: number; tokenUsage: TokenUsage },
  ) => void;
  setTaskDone: (toolCallId: string, idx: number, error?: boolean) => void;
  scheduleClearBatch: (toolCallId: string, delayMs: number) => void;
  cancelScheduledClear: (toolCallId: string) => void;
  clearBatch: (toolCallId: string) => void;
}

type BatchProgressStore = BatchProgressState & BatchProgressActions;

/** Keep a completed batch inspectable in its original session without retaining it forever. */
export const BATCH_PROGRESS_COMPLETED_TTL_MS = 5 * 60 * 1000;
/** StrictMode-safe unmount grace: a development remount cancels this immediately. */
export const BATCH_PROGRESS_UNMOUNT_GRACE_MS = 15 * 60 * 1000;
/** Bound transient renderer memory while retaining normal screenshots and useful text. */
export const BATCH_PROGRESS_MAX_RESULT_CHARS = 20_000;
export const BATCH_PROGRESS_MAX_RICH_CONTENT_CHARS = 16 * 1024 * 1024;
export const BATCH_PROGRESS_MAX_STEPS_PER_TASK = 64;

function richContentChars(content: ToolResultContent[] | undefined): number {
  return content?.reduce((total, block) =>
    total + (block.type === 'image' ? block.source.data.length : block.text.length), 0) ?? 0;
}

function batchRichContentChars(entry: BatchEntry): number {
  return entry.tasks.reduce((batchTotal, task) =>
    batchTotal + task.steps.reduce((taskTotal, step) =>
      taskTotal + richContentChars(step.resultContent), 0), 0);
}

export function retainBatchResultContent(
  content: ToolResultContent[] | undefined,
  availableChars: number,
): ToolResultContent[] | undefined {
  if (!content || availableChars <= 0) return undefined;
  let remaining = availableChars;
  const retained: ToolResultContent[] = [];
  for (const block of content) {
    if (block.type === 'image') {
      if (block.source.data.length > remaining) continue;
      retained.push(block);
      remaining -= block.source.data.length;
      continue;
    }
    if (remaining <= 0) break;
    const text = block.text.slice(0, remaining);
    if (text) retained.push({ type: 'text', text });
    remaining -= text.length;
  }
  return retained.length > 0 ? retained : undefined;
}

function truncateBatchResult(result: string | undefined): string | undefined {
  if (!result || result.length <= BATCH_PROGRESS_MAX_RESULT_CHARS) return result;
  return `${result.slice(0, BATCH_PROGRESS_MAX_RESULT_CHARS)}\n…`;
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

function getObservedStepIds(toolCallId: string): Set<string> {
  let ids = observedStepIds.get(toolCallId);
  if (!ids) {
    ids = new Set<string>();
    observedStepIds.set(toolCallId, ids);
  }
  return ids;
}

function cancelClearTimer(toolCallId: string): void {
  const timer = clearTimers.get(toolCallId);
  if (timer !== undefined) {
    clearTimeout(timer);
    clearTimers.delete(toolCallId);
  }
}

export const useBatchProgressStore = create<BatchProgressStore>()(
  immer((set, get) => ({
    batches: {},

    initBatch: (toolCallId, labels) => {
      cancelClearTimer(toolCallId);
      observedStepIds.delete(toolCallId);
      set((state) => {
        state.batches[toolCallId] = {
          startedAt: Date.now(),
          tasks: labels.map((label) => ({ label, status: 'queued', toolCallCount: 0, steps: [] })),
        };
      });
    },

    setTaskRunning: (toolCallId, idx) => {
      set((state) => {
        const entry = state.batches[toolCallId];
        if (!entry || !entry.tasks[idx]) return;
        entry.tasks[idx].status = 'running';
        entry.tasks[idx].startedAt ??= Date.now();
      });
    },

    setTaskActivity: (toolCallId, idx, activity, turn?) => {
      set((state) => {
        const entry = state.batches[toolCallId];
        if (!entry || !entry.tasks[idx]) return;
        entry.tasks[idx].activity = activity;
        if (turn !== undefined) entry.tasks[idx].turn = turn;
      });
    },

    startTaskStep: (toolCallId, idx, step) => {
      set((state) => {
        const task = state.batches[toolCallId]?.tasks[idx];
        if (!task) return;
        task.status = 'running';
        task.startedAt ??= Date.now();
        const observedIds = getObservedStepIds(toolCallId);
        const observedId = `${idx}:${step.id}`;
        if (observedIds.has(observedId)) return;
        observedIds.add(observedId);
        task.toolCallCount++;
        task.lastToolName = step.toolName;
        if (!makeRoomForStep(task)) return;
        task.steps.push({ ...step, status: 'running', startTime: Date.now() });
      });
    },

    finishTaskStep: (toolCallId, idx, result) => {
      set((state) => {
        const entry = state.batches[toolCallId];
        const task = entry?.tasks[idx];
        if (!entry || !task) return;
        const now = Date.now();
        const step = task.steps.find((existing) => existing.id === result.id);
        if (step) {
          const availableRichChars = Math.max(
            0,
            BATCH_PROGRESS_MAX_RICH_CONTENT_CHARS
              - (batchRichContentChars(entry) - richContentChars(step.resultContent)),
          );
          step.result = truncateBatchResult(result.result);
          step.resultContent = retainBatchResultContent(result.resultContent, availableRichChars);
          step.status = result.error ? 'error' : 'completed';
          step.endTime = now;
          task.lastToolName = step.toolName;
          return;
        }

        // A malformed/late transport must not silently lose a rich result.
        // The normal sidecar order is start -> end; this fallback is only for
        // resilience and deliberately keeps the unknown input empty.
        const observedIds = getObservedStepIds(toolCallId);
        const observedId = `${idx}:${result.id}`;
        if (!observedIds.has(observedId)) {
          observedIds.add(observedId);
          task.toolCallCount++;
        }
        task.lastToolName = result.toolName;
        if (!makeRoomForStep(task)) return;
        const availableRichChars = Math.max(
          0,
          BATCH_PROGRESS_MAX_RICH_CONTENT_CHARS - batchRichContentChars(entry),
        );
        task.steps.push({
          id: result.id,
          toolName: result.toolName,
          toolInput: {},
          result: truncateBatchResult(result.result),
          resultContent: retainBatchResultContent(result.resultContent, availableRichChars),
          status: result.error ? 'error' : 'completed',
          startTime: now,
          endTime: now,
        });
      });
    },

    setTaskTokenUsage: (toolCallId, idx, tokenUsage) => {
      set((state) => {
        const task = state.batches[toolCallId]?.tasks[idx];
        if (!task) return;
        task.tokenUsage = tokenUsage;
      });
    },

    setTaskFinalStats: (toolCallId, idx, stats) => {
      set((state) => {
        const task = state.batches[toolCallId]?.tasks[idx];
        if (!task) return;
        // Progress events keep the live UI current. The terminal result is
        // authoritative for final usage because a direct-answer final turn
        // has no turn-complete callback. Never shrink a count already proven
        // by retained step events.
        task.toolCallCount = Math.max(task.toolCallCount, stats.toolCallCount);
        task.tokenUsage = stats.tokenUsage;
      });
    },

    setTaskDone: (toolCallId, idx, error = false) => {
      let shouldScheduleClear = false;
      set((state) => {
        const entry = state.batches[toolCallId];
        if (!entry || !entry.tasks[idx]) return;
        const task = entry.tasks[idx];
        const now = Date.now();
        task.status = error ? 'error' : 'done';
        task.activity = undefined;
        task.startedAt ??= now;
        task.endedAt = now;
        for (const step of task.steps) {
          if (step.status !== 'running') continue;
          step.status = error ? 'error' : 'completed';
          step.endTime = now;
        }
        shouldScheduleClear = entry.tasks.every((candidate) => candidate.status === 'done' || candidate.status === 'error');
      });
      if (shouldScheduleClear) {
        get().scheduleClearBatch(toolCallId, BATCH_PROGRESS_COMPLETED_TTL_MS);
      }
    },

    scheduleClearBatch: (toolCallId, delayMs) => {
      if (!get().batches[toolCallId]) return;
      cancelClearTimer(toolCallId);
      clearTimers.set(toolCallId, setTimeout(() => {
        clearTimers.delete(toolCallId);
        get().clearBatch(toolCallId);
      }, delayMs));
    },

    cancelScheduledClear: (toolCallId) => {
      cancelClearTimer(toolCallId);
    },

    clearBatch: (toolCallId) => {
      cancelClearTimer(toolCallId);
      observedStepIds.delete(toolCallId);
      set((state) => {
        delete state.batches[toolCallId];
      });
    },
  }))
);

/** Selector hook — returns the batch entry for a given toolCallId, or undefined. */
export function useBatchProgress(toolCallId: string): BatchEntry | undefined {
  return useBatchProgressStore((s) => s.batches[toolCallId]);
}
