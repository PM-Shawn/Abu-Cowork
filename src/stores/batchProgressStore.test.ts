import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  BATCH_PROGRESS_COMPLETED_TTL_MS,
  BATCH_PROGRESS_MAX_RESULT_CHARS,
  BATCH_PROGRESS_MAX_STEPS_PER_TASK,
  retainBatchResultContent,
  useBatchProgressStore,
} from './batchProgressStore';

describe('batchProgressStore', () => {
  beforeEach(() => {
    useBatchProgressStore.setState({ batches: {} });
  });

  afterEach(() => {
    for (const batchId of Object.keys(useBatchProgressStore.getState().batches)) {
      useBatchProgressStore.getState().clearBatch(batchId);
    }
    vi.useRealTimers();
  });

  describe('initBatch', () => {
    it('seeds tasks as queued with correct labels', () => {
      useBatchProgressStore.getState().initBatch('tc-1', ['Task A', 'Task B']);
      const batch = useBatchProgressStore.getState().batches['tc-1'];
      expect(batch).toBeDefined();
      expect(batch.tasks).toHaveLength(2);
      expect(batch.tasks[0]).toEqual({ label: 'Task A', status: 'queued', toolCallCount: 0, steps: [] });
      expect(batch.tasks[1]).toEqual({ label: 'Task B', status: 'queued', toolCallCount: 0, steps: [] });
    });

    it('records startedAt close to now', () => {
      // Deterministic: freeze the clock instead of bracketing a real
      // Date.now() read with before/after real-time bounds (TESTING.md §3).
      const fixedNow = 1_700_000_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(fixedNow);
      try {
        useBatchProgressStore.getState().initBatch('tc-2', ['X']);
        const batch = useBatchProgressStore.getState().batches['tc-2'];
        expect(batch.startedAt).toBe(fixedNow);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('setTaskRunning', () => {
    it('marks the task as running', () => {
      useBatchProgressStore.getState().initBatch('tc-3', ['Task A', 'Task B']);
      useBatchProgressStore.getState().setTaskRunning('tc-3', 0);
      expect(useBatchProgressStore.getState().batches['tc-3'].tasks[0].status).toBe('running');
      // Other tasks unaffected
      expect(useBatchProgressStore.getState().batches['tc-3'].tasks[1].status).toBe('queued');
    });

    it('no-ops on unknown toolCallId', () => {
      expect(() => useBatchProgressStore.getState().setTaskRunning('unknown', 0)).not.toThrow();
    });
  });

  describe('setTaskActivity', () => {
    it('updates activity and turn', () => {
      useBatchProgressStore.getState().initBatch('tc-4', ['Task A']);
      useBatchProgressStore.getState().setTaskActivity('tc-4', 0, '调用 web_search', 2);
      const task = useBatchProgressStore.getState().batches['tc-4'].tasks[0];
      expect(task.activity).toBe('调用 web_search');
      expect(task.turn).toBe(2);
    });
  });

  describe('tool steps', () => {
    it('retains a rich tool result and backfills a late tool-end without dropping it', () => {
      const fixedNow = 1_700_000_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(fixedNow);
      const store = useBatchProgressStore.getState();
      store.initBatch('tc-rich', ['Task A']);
      store.startTaskStep('tc-rich', 0, {
        id: 'tool-1',
        toolName: 'abu-browser__screenshot',
        toolInput: { fullPage: true },
      });
      vi.setSystemTime(fixedNow + 250);
      const image = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } }] as const;
      store.finishTaskStep('tc-rich', 0, {
        id: 'tool-1',
        toolName: 'abu-browser__screenshot',
        result: 'Screenshot',
        resultContent: [...image],
        error: false,
      });
      store.finishTaskStep('tc-rich', 0, {
        id: 'late-tool',
        toolName: 'read_file',
        result: 'Late rich result',
        resultContent: [...image],
        error: true,
      });

      const task = useBatchProgressStore.getState().batches['tc-rich'].tasks[0];
      expect(task.toolCallCount).toBe(2);
      expect(task.lastToolName).toBe('read_file');
      expect(task.steps[0]).toMatchObject({ status: 'completed', endTime: fixedNow + 250, resultContent: image });
      expect(task.steps[1]).toMatchObject({ id: 'late-tool', toolName: 'read_file', status: 'error', resultContent: image });
    });

    it('records cumulative token usage from progress', () => {
      const store = useBatchProgressStore.getState();
      store.initBatch('tc-usage', ['Task A']);
      store.setTaskTokenUsage('tc-usage', 0, { inputTokens: 120, outputTokens: 45 });
      expect(useBatchProgressStore.getState().batches['tc-usage'].tasks[0].tokenUsage)
        .toEqual({ inputTokens: 120, outputTokens: 45 });
    });

    it('backfills terminal counters without shrinking retained step evidence', () => {
      const store = useBatchProgressStore.getState();
      store.initBatch('tc-final', ['Task A']);
      store.startTaskStep('tc-final', 0, { id: 'tool-1', toolName: 'read_file', toolInput: {} });
      store.setTaskFinalStats('tc-final', 0, {
        toolCallCount: 3,
        tokenUsage: { inputTokens: 90, outputTokens: 30 },
      });
      store.setTaskFinalStats('tc-final', 0, {
        toolCallCount: 0,
        tokenUsage: { inputTokens: 100, outputTokens: 40 },
      });

      const task = useBatchProgressStore.getState().batches['tc-final'].tasks[0];
      expect(task.toolCallCount).toBe(3);
      expect(task.tokenUsage).toEqual({ inputTokens: 100, outputTokens: 40 });
    });

    it('bounds retained step history and rich/text payloads for the ephemeral renderer store', () => {
      const store = useBatchProgressStore.getState();
      store.initBatch('tc-bounded', ['Task A']);
      for (let i = 0; i <= BATCH_PROGRESS_MAX_STEPS_PER_TASK; i++) {
        store.startTaskStep('tc-bounded', 0, { id: `tool-${i}`, toolName: 'read_file', toolInput: {} });
      }
      // The overflow start is not retained while all 64 existing entries are
      // running. Once one is terminal, its slot can be reused for the late
      // result without ever evicting active work.
      store.finishTaskStep('tc-bounded', 0, {
        id: 'tool-0',
        toolName: 'read_file',
        result: 'first completed',
        error: false,
      });
      store.finishTaskStep('tc-bounded', 0, {
        id: `tool-${BATCH_PROGRESS_MAX_STEPS_PER_TASK}`,
        toolName: 'read_file',
        result: 'x'.repeat(BATCH_PROGRESS_MAX_RESULT_CHARS + 10),
        error: false,
      });

      const task = useBatchProgressStore.getState().batches['tc-bounded'].tasks[0];
      expect(task.toolCallCount).toBe(BATCH_PROGRESS_MAX_STEPS_PER_TASK + 1);
      expect(task.steps).toHaveLength(BATCH_PROGRESS_MAX_STEPS_PER_TASK);
      expect(task.steps[0].id).toBe('tool-1');
      expect(task.steps.at(-1)?.result).toHaveLength(BATCH_PROGRESS_MAX_RESULT_CHARS + 2);
      expect(retainBatchResultContent([
        { type: 'text', text: 'abcdef' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'image' } },
      ], 4)).toEqual([{ type: 'text', text: 'abcd' }]);
    });

    it('keeps running steps at the cap and does not double-count their late tool-end', () => {
      const store = useBatchProgressStore.getState();
      store.initBatch('tc-running-cap', ['Task A']);
      for (let i = 0; i < BATCH_PROGRESS_MAX_STEPS_PER_TASK; i++) {
        store.startTaskStep('tc-running-cap', 0, { id: `running-${i}`, toolName: 'read_file', toolInput: {} });
      }

      store.startTaskStep('tc-running-cap', 0, { id: 'overflow', toolName: 'list_directory', toolInput: {} });
      let task = useBatchProgressStore.getState().batches['tc-running-cap'].tasks[0];
      expect(task.steps).toHaveLength(BATCH_PROGRESS_MAX_STEPS_PER_TASK);
      expect(task.steps.every((step) => step.status === 'running')).toBe(true);
      expect(task.steps.map((step) => step.id)).not.toContain('overflow');
      expect(task.toolCallCount).toBe(BATCH_PROGRESS_MAX_STEPS_PER_TASK + 1);

      // Once an existing running step is terminal, the late end can be shown
      // by replacing terminal evidence, without either evicting active work
      // or incrementing the count a second time.
      store.finishTaskStep('tc-running-cap', 0, {
        id: 'running-0', toolName: 'read_file', result: 'done', error: false,
      });
      store.finishTaskStep('tc-running-cap', 0, {
        id: 'overflow', toolName: 'list_directory', result: 'late done', error: false,
      });
      store.finishTaskStep('tc-running-cap', 0, {
        id: 'overflow', toolName: 'list_directory', result: 'duplicate late done', error: false,
      });

      task = useBatchProgressStore.getState().batches['tc-running-cap'].tasks[0];
      expect(task.steps).toHaveLength(BATCH_PROGRESS_MAX_STEPS_PER_TASK);
      expect(task.steps.filter((step) => step.status === 'running')).toHaveLength(BATCH_PROGRESS_MAX_STEPS_PER_TASK - 1);
      expect(task.toolCallCount).toBe(BATCH_PROGRESS_MAX_STEPS_PER_TASK + 1);
    });
  });

  describe('setTaskDone', () => {
    it('marks task done on success', () => {
      useBatchProgressStore.getState().initBatch('tc-5', ['Task A']);
      useBatchProgressStore.getState().setTaskDone('tc-5', 0, false);
      expect(useBatchProgressStore.getState().batches['tc-5'].tasks[0].status).toBe('done');
    });

    it('marks task error on failure', () => {
      useBatchProgressStore.getState().initBatch('tc-6', ['Task A']);
      useBatchProgressStore.getState().setTaskDone('tc-6', 0, true);
      expect(useBatchProgressStore.getState().batches['tc-6'].tasks[0].status).toBe('error');
    });

    it('clears activity on done', () => {
      useBatchProgressStore.getState().initBatch('tc-7', ['Task A']);
      useBatchProgressStore.getState().setTaskActivity('tc-7', 0, '调用工具', 1);
      useBatchProgressStore.getState().setTaskDone('tc-7', 0);
      expect(useBatchProgressStore.getState().batches['tc-7'].tasks[0].activity).toBeUndefined();
    });

    it('terminalizes a start-only step when its tool-end event is missing', () => {
      const fixedNow = 1_700_000_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(fixedNow);
      const store = useBatchProgressStore.getState();
      store.initBatch('tc-missing-end', ['Task A']);
      store.startTaskStep('tc-missing-end', 0, { id: 'lost-end', toolName: 'read_file', toolInput: {} });
      vi.setSystemTime(fixedNow + 500);
      store.setTaskDone('tc-missing-end', 0, true);

      expect(useBatchProgressStore.getState().batches['tc-missing-end'].tasks[0].steps[0])
        .toMatchObject({ status: 'error', endTime: fixedNow + 500 });
    });
  });

  describe('clearBatch', () => {
    it('removes the batch entry', () => {
      useBatchProgressStore.getState().initBatch('tc-8', ['Task A']);
      useBatchProgressStore.getState().clearBatch('tc-8');
      expect(useBatchProgressStore.getState().batches['tc-8']).toBeUndefined();
    });

    it('cleans terminal batches after the bounded TTL even if the UI unmounted', () => {
      const fixedNow = 1_700_000_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(fixedNow);
      const store = useBatchProgressStore.getState();
      store.initBatch('tc-ttl', ['Task A', 'Task B']);
      store.setTaskDone('tc-ttl', 0);
      vi.advanceTimersByTime(BATCH_PROGRESS_COMPLETED_TTL_MS);
      expect(useBatchProgressStore.getState().batches['tc-ttl']).toBeDefined();
      store.setTaskDone('tc-ttl', 1);
      vi.advanceTimersByTime(BATCH_PROGRESS_COMPLETED_TTL_MS - 1);
      expect(useBatchProgressStore.getState().batches['tc-ttl']).toBeDefined();
      vi.advanceTimersByTime(1);
      expect(useBatchProgressStore.getState().batches['tc-ttl']).toBeUndefined();
    });

    it('cancels a pending clear when a retained card remounts', () => {
      vi.useFakeTimers();
      const store = useBatchProgressStore.getState();
      store.initBatch('tc-cancel', ['Task A']);
      store.scheduleClearBatch('tc-cancel', 100);
      store.cancelScheduledClear('tc-cancel');
      vi.advanceTimersByTime(100);
      expect(useBatchProgressStore.getState().batches['tc-cancel']).toBeDefined();
    });
  });
});
