/**
 * Batch progress store — ephemeral UI state for run_agent_batch live progress.
 *
 * EPHEMERAL: no persist middleware. This is transient UI state that doesn't
 * survive page reloads. Intentional — in-flight batches can't be resumed anyway.
 */
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

export type BatchTaskStatus = 'queued' | 'running' | 'done' | 'error';

export interface BatchTaskProgress {
  label: string;
  status: BatchTaskStatus;
  activity?: string;
  turn?: number;
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
  setTaskDone: (toolCallId: string, idx: number, error?: boolean) => void;
  clearBatch: (toolCallId: string) => void;
}

type BatchProgressStore = BatchProgressState & BatchProgressActions;

export const useBatchProgressStore = create<BatchProgressStore>()(
  immer((set) => ({
    batches: {},

    initBatch: (toolCallId, labels) => {
      set((state) => {
        state.batches[toolCallId] = {
          startedAt: Date.now(),
          tasks: labels.map((label) => ({ label, status: 'queued' })),
        };
      });
    },

    setTaskRunning: (toolCallId, idx) => {
      set((state) => {
        const entry = state.batches[toolCallId];
        if (!entry || !entry.tasks[idx]) return;
        entry.tasks[idx].status = 'running';
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

    setTaskDone: (toolCallId, idx, error = false) => {
      set((state) => {
        const entry = state.batches[toolCallId];
        if (!entry || !entry.tasks[idx]) return;
        entry.tasks[idx].status = error ? 'error' : 'done';
        entry.tasks[idx].activity = undefined;
      });
    },

    clearBatch: (toolCallId) => {
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
