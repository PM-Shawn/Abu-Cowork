import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  BATCH_PROGRESS_COMPLETED_TTL_MS,
  BATCH_PROGRESS_GLOBAL_RICH_CONTENT_BYTES,
  BATCH_PROGRESS_MAX_RICH_CONTENT_BYTES,
  BATCH_PROGRESS_MAX_RESULT_CHARS,
  BATCH_PROGRESS_MAX_STEPS_PER_TASK,
  retainBatchResultContent,
  useBatchProgressStore,
} from './batchProgressStore';
import { makeBatchKey, type BatchIdentity } from '@/types';

function identity(conversationId: string, batchToolCallId = 'shared-tool-call'): BatchIdentity {
  return { conversationId, batchToolCallId };
}

function testIdentity(batchToolCallId: string): BatchIdentity {
  return identity(`conv-${batchToolCallId}`, batchToolCallId);
}

function batch(identityValue: BatchIdentity) {
  return useBatchProgressStore.getState().batches[makeBatchKey(identityValue)];
}

function resetBatchProgressStore() {
  useBatchProgressStore.setState({
    batches: {},
    activeVisibleBatchKey: undefined,
    richAccessClock: 0,
    richContentDiagnostics: {
      totalRetainedRichBytes: 0,
      retainedRichBytesCap: BATCH_PROGRESS_GLOBAL_RICH_CONTENT_BYTES,
      overageBytes: 0,
      evictionCount: 0,
      releasedBatchCount: 0,
      lastEvictedKey: undefined,
    },
  });
}

function finishRichBatch(id: BatchIdentity, size: number, taskIndex = 0, stepId = 'tool-1') {
  const store = useBatchProgressStore.getState();
  store.initBatch(id, ['Task A']);
  store.startTaskStep(id, taskIndex, { id: stepId, toolName: 'abu-browser__screenshot', toolInput: {} });
  store.finishTaskStep(id, taskIndex, {
    id: stepId,
    toolName: 'abu-browser__screenshot',
    result: 'Screenshot',
    resultContent: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a'.repeat(size) } }],
    error: false,
  });
  store.setTaskTerminal(id, taskIndex, { status: 'succeeded', reason: 'completed' });
}

describe('batchProgressStore', () => {
  beforeEach(() => {
    resetBatchProgressStore();
  });

  afterEach(() => {
    for (const entry of Object.values(useBatchProgressStore.getState().batches)) {
      useBatchProgressStore.getState().clearBatch(entry.identity);
    }
    vi.useRealTimers();
  });

  describe('initBatch', () => {
    it('seeds tasks as queued with correct labels', () => {
      const id = testIdentity('tc-1');
      useBatchProgressStore.getState().initBatch(id, ['Task A', 'Task B']);
      const entry = batch(id);
      expect(entry).toBeDefined();
      expect(entry.tasks).toHaveLength(2);
      expect(entry.tasks[0]).toEqual({ label: 'Task A', status: 'queued', toolCallCount: 0, steps: [] });
      expect(entry.tasks[1]).toEqual({ label: 'Task B', status: 'queued', toolCallCount: 0, steps: [] });
    });

    it('records startedAt close to now', () => {
      // Deterministic: freeze the clock instead of bracketing a real
      // Date.now() read with before/after real-time bounds (TESTING.md §3).
      const fixedNow = 1_700_000_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(fixedNow);
      try {
        const id = testIdentity('tc-2');
        useBatchProgressStore.getState().initBatch(id, ['X']);
        expect(batch(id).startedAt).toBe(fixedNow);
      } finally {
        vi.useRealTimers();
      }
    });

    it('isolates two conversations with the same batch tool call id', () => {
      const a = identity('conv-a');
      const b = identity('conv-b');
      useBatchProgressStore.getState().initBatch(a, ['Task A']);
      useBatchProgressStore.getState().initBatch(b, ['Task B']);
      useBatchProgressStore.getState().setTaskRunning(a, 0);

      expect(batch(a).tasks[0].status).toBe('running');
      expect(batch(b).tasks[0].status).toBe('queued');
    });
  });

  describe('setTaskRunning', () => {
    it('marks the task as running', () => {
      const id = testIdentity('tc-3');
      useBatchProgressStore.getState().initBatch(id, ['Task A', 'Task B']);
      useBatchProgressStore.getState().setTaskRunning(id, 0);
      expect(batch(id).tasks[0].status).toBe('running');
      // Other tasks unaffected
      expect(batch(id).tasks[1].status).toBe('queued');
    });

    it('no-ops on unknown identity', () => {
      expect(() => useBatchProgressStore.getState().setTaskRunning(testIdentity('unknown'), 0)).not.toThrow();
    });
  });

  describe('setTaskActivity', () => {
    it('updates activity and turn', () => {
      const id = testIdentity('tc-4');
      useBatchProgressStore.getState().initBatch(id, ['Task A']);
      useBatchProgressStore.getState().setTaskActivity(id, 0, '调用 web_search', 2);
      const task = batch(id).tasks[0];
      expect(task.activity).toBe('调用 web_search');
      expect(task.turn).toBe(2);
    });
  });

  describe('tool steps', () => {
    it('retains a rich tool result and backfills a late tool-end without dropping it', () => {
      const fixedNow = 1_700_000_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(fixedNow);
      const id = testIdentity('tc-rich');
      const store = useBatchProgressStore.getState();
      store.initBatch(id, ['Task A']);
      store.startTaskStep(id, 0, {
        id: 'tool-1',
        toolName: 'abu-browser__screenshot',
        toolInput: { fullPage: true },
      });
      vi.setSystemTime(fixedNow + 250);
      const image = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } }] as const;
      store.finishTaskStep(id, 0, {
        id: 'tool-1',
        toolName: 'abu-browser__screenshot',
        result: 'Screenshot',
        resultContent: [...image],
        error: false,
      });
      store.finishTaskStep(id, 0, {
        id: 'late-tool',
        toolName: 'read_file',
        result: 'Late rich result',
        resultContent: [...image],
        error: true,
      });

      const task = batch(id).tasks[0];
      expect(task.toolCallCount).toBe(2);
      expect(task.lastToolName).toBe('read_file');
      expect(task.steps[0]).toMatchObject({ status: 'completed', endTime: fixedNow + 250, resultContent: image });
      expect(task.steps[1]).toMatchObject({ id: 'late-tool', toolName: 'read_file', status: 'error', resultContent: image });
    });

    it('records cumulative token usage from progress', () => {
      const id = testIdentity('tc-usage');
      const store = useBatchProgressStore.getState();
      store.initBatch(id, ['Task A']);
      store.setTaskTokenUsage(id, 0, { inputTokens: 120, outputTokens: 45 });
      expect(batch(id).tasks[0].tokenUsage)
        .toEqual({ inputTokens: 120, outputTokens: 45 });
    });

    it('backfills terminal counters without shrinking retained step evidence', () => {
      const id = testIdentity('tc-final');
      const store = useBatchProgressStore.getState();
      store.initBatch(id, ['Task A']);
      store.startTaskStep(id, 0, { id: 'tool-1', toolName: 'read_file', toolInput: {} });
      store.setTaskFinalStats(id, 0, {
        toolCallCount: 3,
        tokenUsage: { inputTokens: 90, outputTokens: 30 },
      });
      store.setTaskFinalStats(id, 0, {
        toolCallCount: 0,
        tokenUsage: { inputTokens: 100, outputTokens: 40 },
      });

      const task = batch(id).tasks[0];
      expect(task.toolCallCount).toBe(3);
      expect(task.tokenUsage).toEqual({ inputTokens: 100, outputTokens: 40 });
    });

    it('bounds retained step history and rich/text payloads for the ephemeral renderer store', () => {
      const id = testIdentity('tc-bounded');
      const store = useBatchProgressStore.getState();
      store.initBatch(id, ['Task A']);
      for (let i = 0; i <= BATCH_PROGRESS_MAX_STEPS_PER_TASK; i++) {
        store.startTaskStep(id, 0, { id: `tool-${i}`, toolName: 'read_file', toolInput: {} });
      }
      // The overflow start is not retained while all 64 existing entries are
      // running. Once one is terminal, its slot can be reused for the late
      // result without ever evicting active work.
      store.finishTaskStep(id, 0, {
        id: 'tool-0',
        toolName: 'read_file',
        result: 'first completed',
        error: false,
      });
      store.finishTaskStep(id, 0, {
        id: `tool-${BATCH_PROGRESS_MAX_STEPS_PER_TASK}`,
        toolName: 'read_file',
        result: 'x'.repeat(BATCH_PROGRESS_MAX_RESULT_CHARS + 10),
        error: false,
      });

      const task = batch(id).tasks[0];
      expect(task.toolCallCount).toBe(BATCH_PROGRESS_MAX_STEPS_PER_TASK + 1);
      expect(task.steps).toHaveLength(BATCH_PROGRESS_MAX_STEPS_PER_TASK);
      expect(task.steps[0].id).toBe('tool-1');
      expect(task.steps.at(-1)?.result).toHaveLength(BATCH_PROGRESS_MAX_RESULT_CHARS + 2);
      expect(retainBatchResultContent([
        { type: 'text', text: 'abcdef' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'image' } },
      ], 4)).toEqual([{ type: 'text', text: 'abcd' }]);
      expect(retainBatchResultContent([
        { type: 'text', text: 'é你abc' },
      ], 5)).toEqual([{ type: 'text', text: 'é你' }]);
      expect(retainBatchResultContent([{ type: 'text', text: 'a😀b' }], 3))
        .toEqual([{ type: 'text', text: 'a' }]);
      expect(retainBatchResultContent([{ type: 'text', text: 'a😀b' }], 5))
        .toEqual([{ type: 'text', text: 'a😀' }]);
      expect(retainBatchResultContent([{ type: 'text', text: 'a😀b' }], 6))
        .toEqual([{ type: 'text', text: 'a😀b' }]);
    });

    it('truncates large near-boundary UTF-8 text without per-code-point encoder work or emoji corruption', () => {
      const retained = retainBatchResultContent([
        { type: 'text', text: `${'a'.repeat(BATCH_PROGRESS_MAX_RICH_CONTENT_BYTES - 1)}😀x` },
      ], BATCH_PROGRESS_MAX_RICH_CONTENT_BYTES);

      expect(retained).toHaveLength(1);
      expect(retained?.[0].type).toBe('text');
      if (retained?.[0].type !== 'text') return;
      expect(retained[0].text).toHaveLength(BATCH_PROGRESS_MAX_RICH_CONTENT_BYTES - 1);
      expect(retained[0].text.endsWith('\uD83D')).toBe(false);
      expect(retained[0].text).not.toContain('�');
    });

    it('keeps running steps at the cap and does not double-count their late tool-end', () => {
      const id = testIdentity('tc-running-cap');
      const store = useBatchProgressStore.getState();
      store.initBatch(id, ['Task A']);
      for (let i = 0; i < BATCH_PROGRESS_MAX_STEPS_PER_TASK; i++) {
        store.startTaskStep(id, 0, { id: `running-${i}`, toolName: 'read_file', toolInput: {} });
      }

      store.startTaskStep(id, 0, { id: 'overflow', toolName: 'list_directory', toolInput: {} });
      let task = batch(id).tasks[0];
      expect(task.steps).toHaveLength(BATCH_PROGRESS_MAX_STEPS_PER_TASK);
      expect(task.steps.every((step) => step.status === 'running')).toBe(true);
      expect(task.steps.map((step) => step.id)).not.toContain('overflow');
      expect(task.toolCallCount).toBe(BATCH_PROGRESS_MAX_STEPS_PER_TASK + 1);

      // Once an existing running step is terminal, the late end can be shown
      // by replacing terminal evidence, without either evicting active work
      // or incrementing the count a second time.
      store.finishTaskStep(id, 0, {
        id: 'running-0', toolName: 'read_file', result: 'done', error: false,
      });
      store.finishTaskStep(id, 0, {
        id: 'overflow', toolName: 'list_directory', result: 'late done', error: false,
      });
      store.finishTaskStep(id, 0, {
        id: 'overflow', toolName: 'list_directory', result: 'duplicate late done', error: false,
      });

      task = batch(id).tasks[0];
      expect(task.steps).toHaveLength(BATCH_PROGRESS_MAX_STEPS_PER_TASK);
      expect(task.steps.filter((step) => step.status === 'running')).toHaveLength(BATCH_PROGRESS_MAX_STEPS_PER_TASK - 1);
      expect(task.toolCallCount).toBe(BATCH_PROGRESS_MAX_STEPS_PER_TASK + 1);
    });

    it('ignores late tool-end events after the task is terminal', () => {
      const id = testIdentity('tc-terminal-late');
      const store = useBatchProgressStore.getState();
      store.initBatch(id, ['Task A']);
      store.startTaskStep(id, 0, { id: 'tool-1', toolName: 'read_file', toolInput: {} });
      store.setTaskTerminal(id, 0, { status: 'stopped', reason: 'aborted' });
      store.finishTaskStep(id, 0, {
        id: 'tool-1',
        toolName: 'read_file',
        result: 'late success',
        error: false,
      });
      store.finishTaskStep(id, 0, {
        id: 'tool-2',
        toolName: 'list_directory',
        result: 'late new success',
        error: false,
      });

      const task = batch(id).tasks[0];
      expect(task.status).toBe('stopped');
      expect(task.steps).toHaveLength(1);
      expect(task.steps[0]).toMatchObject({ id: 'tool-1', status: 'cancelled' });
      expect(task.toolCallCount).toBe(1);
    });
  });

  describe('setTaskTerminal', () => {
    it('records structured terminal statuses and builds a minimal summary', () => {
      const batchId = identity('conv-terminal', 'batch-terminal');
      const store = useBatchProgressStore.getState();
      store.initBatch(batchId, ['A', 'B', 'C', 'D']);
      const partial = store.setTaskTerminal(batchId, 0, { status: 'succeeded', reason: 'completed' });
      expect(partial).toEqual({
        version: 1,
        batch: batchId,
        taskCount: 4,
        counts: { succeeded: 1, failed: 0, stopped: 0, incomplete: 0 },
        tasks: [{ taskIndex: 0, status: 'succeeded', terminalReason: 'completed' }],
      });
      store.setTaskTerminal(batchId, 1, { status: 'failed', reason: 'timeout' });
      store.setTaskTerminal(batchId, 2, { status: 'stopped', reason: 'aborted' });
      const summary = store.setTaskTerminal(batchId, 3, { status: 'incomplete', reason: 'max_turns' });

      expect(batch(batchId).tasks.map((task) => task.status)).toEqual([
        'succeeded',
        'failed',
        'stopped',
        'incomplete',
      ]);
      expect(summary).toEqual({
        version: 1,
        batch: batchId,
        taskCount: 4,
        counts: { succeeded: 1, failed: 1, stopped: 1, incomplete: 1 },
        tasks: [
          { taskIndex: 0, status: 'succeeded', terminalReason: 'completed' },
          { taskIndex: 1, status: 'failed', terminalReason: 'timeout' },
          { taskIndex: 2, status: 'stopped', terminalReason: 'aborted' },
          { taskIndex: 3, status: 'incomplete', terminalReason: 'max_turns' },
        ],
      });
    });

    it('is idempotent and queued to stopped does not invent startedAt', () => {
      const fixedNow = 1_700_000_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(fixedNow);
      const batchId = identity('conv-idempotent', 'batch-idempotent');
      const store = useBatchProgressStore.getState();
      store.initBatch(batchId, ['A']);
      store.setTaskTerminal(batchId, 0, { status: 'stopped', reason: 'aborted' });
      vi.setSystemTime(fixedNow + 1000);
      store.setTaskTerminal(batchId, 0, { status: 'succeeded', reason: 'completed' });

      const task = batch(batchId).tasks[0];
      expect(task.status).toBe('stopped');
      expect(task.terminalReason).toBe('aborted');
      expect(task.startedAt).toBeUndefined();
      expect(task.endedAt).toBe(fixedNow);
    });

    it('terminalizes running steps on stopped task without marking the task failed', () => {
      const batchId = identity('conv-stopped-step', 'batch-stopped-step');
      const store = useBatchProgressStore.getState();
      store.initBatch(batchId, ['A']);
      store.startTaskStep(batchId, 0, { id: 'tool-1', toolName: 'read_file', toolInput: {} });
      store.setTaskTerminal(batchId, 0, { status: 'stopped', reason: 'aborted' });

      const task = batch(batchId).tasks[0];
      expect(task.status).toBe('stopped');
      expect(task.steps[0].status).toBe('cancelled');
      expect(task.steps[0].endTime).toBeDefined();
    });

    it('clears activity and terminalizes a start-only step when its tool-end event is missing', () => {
      const fixedNow = 1_700_000_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(fixedNow);
      const id = testIdentity('tc-missing-end');
      const store = useBatchProgressStore.getState();
      store.initBatch(id, ['Task A']);
      store.setTaskActivity(id, 0, '调用工具', 1);
      store.startTaskStep(id, 0, { id: 'lost-end', toolName: 'read_file', toolInput: {} });
      vi.setSystemTime(fixedNow + 500);
      store.setTaskTerminal(id, 0, { status: 'failed', reason: 'error' });

      const task = batch(id).tasks[0];
      expect(task.activity).toBeUndefined();
      expect(task.steps[0]).toMatchObject({ status: 'error', endTime: fixedNow + 500 });
    });
  });

  describe('clearBatch', () => {
    it('removes the batch entry', () => {
      const id = testIdentity('tc-8');
      useBatchProgressStore.getState().initBatch(id, ['Task A']);
      useBatchProgressStore.getState().clearBatch(id);
      expect(batch(id)).toBeUndefined();
    });

    it('cleans terminal batches after the bounded TTL even if the UI unmounted', () => {
      const fixedNow = 1_700_000_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(fixedNow);
      const id = testIdentity('tc-ttl');
      const store = useBatchProgressStore.getState();
      store.initBatch(id, ['Task A', 'Task B']);
      store.setTaskTerminal(id, 0, { status: 'succeeded', reason: 'completed' });
      vi.advanceTimersByTime(BATCH_PROGRESS_COMPLETED_TTL_MS);
      expect(batch(id)).toBeDefined();
      store.setTaskTerminal(id, 1, { status: 'succeeded', reason: 'completed' });
      vi.advanceTimersByTime(BATCH_PROGRESS_COMPLETED_TTL_MS - 1);
      expect(batch(id)).toBeDefined();
      vi.advanceTimersByTime(1);
      expect(batch(id)).toBeUndefined();
    });

    it('cancels a pending clear when a retained card remounts', () => {
      vi.useFakeTimers();
      const id = testIdentity('tc-cancel');
      const store = useBatchProgressStore.getState();
      store.initBatch(id, ['Task A']);
      store.setTaskTerminal(id, 0, { status: 'succeeded', reason: 'completed' });
      store.scheduleClearBatch(id, 100);
      store.cancelScheduledClear(id);
      vi.advanceTimersByTime(100);
      expect(batch(id)).toBeDefined();
    });

    it('only clears after terminal state has no run or view lease and rechecks at timer fire', () => {
      vi.useFakeTimers();
      const batchId = identity('conv-lease', 'batch-lease');
      const store = useBatchProgressStore.getState();
      store.initBatch(batchId, ['A']);
      store.acquireViewLease(batchId);
      store.setTaskTerminal(batchId, 0, { status: 'succeeded', reason: 'completed' });

      vi.advanceTimersByTime(BATCH_PROGRESS_COMPLETED_TTL_MS);
      expect(batch(batchId)).toBeDefined();

      store.releaseViewLease(batchId);
      store.acquireViewLease(batchId);
      vi.advanceTimersByTime(BATCH_PROGRESS_COMPLETED_TTL_MS);
      expect(batch(batchId)).toBeDefined();

      store.releaseViewLease(batchId);
      vi.advanceTimersByTime(BATCH_PROGRESS_COMPLETED_TTL_MS);
      expect(batch(batchId)).toBeUndefined();
    });
  });

  describe('rich retention LRU', () => {
    it('accounts retained rich bytes exactly and caps one batch at 16 MiB', () => {
      const accounting = testIdentity('rich-accounting');
      const cap = testIdentity('rich-cap');
      const store = useBatchProgressStore.getState();
      store.initBatch(accounting, ['A']);
      store.finishTaskStep(accounting, 0, {
        id: 'tool-1',
        toolName: 'read_file',
        result: 'mixed',
        resultContent: [
          { type: 'text', text: 'é你' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abcd' } },
        ],
        error: false,
      });

      expect(batch(accounting).retainedRichBytes).toBe(9);
      expect(useBatchProgressStore.getState().richContentDiagnostics.totalRetainedRichBytes).toBe(9);

      store.initBatch(cap, ['A']);
      store.finishTaskStep(cap, 0, {
        id: 'huge',
        toolName: 'read_file',
        result: 'huge',
        resultContent: [{ type: 'text', text: 'x'.repeat(BATCH_PROGRESS_MAX_RICH_CONTENT_BYTES + 100) }],
        error: false,
      });
      expect(batch(cap).retainedRichBytes).toBe(BATCH_PROGRESS_MAX_RICH_CONTENT_BYTES);
    });

    it('evicts terminal rich content by deterministic LRU and canonical-key tie-break', () => {
      const a = identity('conv-a', 'batch-rich');
      const b = identity('conv-b', 'batch-rich');
      const c = identity('conv-c', 'batch-rich');
      const payloadSize = 12 * 1024 * 1024;
      finishRichBatch(a, payloadSize);
      finishRichBatch(c, payloadSize);
      useBatchProgressStore.setState((state) => {
        state.batches[makeBatchKey(a)].lastRichAccessTick = 0;
        state.batches[makeBatchKey(c)].lastRichAccessTick = 0;
      });
      finishRichBatch(b, payloadSize);

      const state = useBatchProgressStore.getState();
      const releasedKey = makeBatchKey(a);
      expect(state.richContentDiagnostics.totalRetainedRichBytes).toBe(payloadSize * 2);
      expect(state.richContentDiagnostics.evictionCount).toBe(1);
      expect(state.richContentDiagnostics.lastEvictedKey).toBe(releasedKey);
      expect(batch(a).retainedRichBytes).toBe(0);
      expect(batch(a).tasks[0].steps[0].richContentState).toBe('released');
      expect(batch(b).retainedRichBytes).toBe(payloadSize);
      expect(batch(c).retainedRichBytes).toBe(payloadSize);
    });

    it('protects the active visible terminal batch but allows inactive leased terminal batches', () => {
      const visible = identity('conv-visible', 'batch-rich');
      const leased = identity('conv-leased', 'batch-rich');
      const extra = identity('conv-extra', 'batch-rich');
      const payloadSize = 12 * 1024 * 1024;
      finishRichBatch(visible, payloadSize);
      useBatchProgressStore.getState().setActiveVisibleBatch(visible);
      finishRichBatch(leased, payloadSize);
      useBatchProgressStore.getState().acquireViewLease(leased);
      finishRichBatch(extra, payloadSize);

      expect(batch(visible).retainedRichBytes).toBe(payloadSize);
      expect(batch(leased).viewLeaseCount).toBe(1);
      expect(batch(leased).retainedRichBytes).toBe(0);
      expect(batch(leased).tasks[0].steps[0]).toMatchObject({
        result: 'Screenshot',
        richContentState: 'released',
      });
      expect(batch(leased).tasks[0].steps[0].resultContent).toBeUndefined();
    });

    it('protects running batches, reports overage when no candidate exists, then converges after terminal visibility changes', () => {
      const active = identity('conv-active', 'batch-rich');
      const running = identity('conv-running', 'batch-rich');
      const payloadSize = 16 * 1024 * 1024;
      const store = useBatchProgressStore.getState();

      store.initBatch(active, ['A']);
      store.finishTaskStep(active, 0, {
        id: 'active-rich',
        toolName: 'read_file',
        result: 'active',
        resultContent: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a'.repeat(payloadSize) } }],
        error: false,
      });
      store.setTaskTerminal(active, 0, { status: 'succeeded', reason: 'completed' });
      store.setActiveVisibleBatch(active);

      store.initBatch(running, ['A']);
      store.startTaskStep(running, 0, { id: 'running-rich', toolName: 'read_file', toolInput: {} });
      store.finishTaskStep(running, 0, {
        id: 'running-rich',
        toolName: 'read_file',
        result: 'running',
        resultContent: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'b'.repeat(payloadSize) } }],
        error: false,
      });
      // With only protected entries at exactly the cap, there is no overage.
      store.initBatch(identity('conv-over', 'batch-rich'), ['A']);
      store.finishTaskStep(identity('conv-over', 'batch-rich'), 0, {
        id: 'over-rich',
        toolName: 'read_file',
        result: 'over',
        resultContent: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'c'.repeat(1) } }],
        error: false,
      });
      expect(useBatchProgressStore.getState().richContentDiagnostics.overageBytes).toBe(1);

      store.setTaskTerminal(running, 0, { status: 'succeeded', reason: 'completed' });
      expect(batch(running).retainedRichBytes).toBe(0);
      expect(useBatchProgressStore.getState().richContentDiagnostics.overageBytes).toBe(0);

      store.setActiveVisibleBatch(undefined);
      expect(useBatchProgressStore.getState().richContentDiagnostics.totalRetainedRichBytes)
        .toBeLessThanOrEqual(BATCH_PROGRESS_GLOBAL_RICH_CONTENT_BYTES);
    });

    it('is idempotent for explicit rich release and clear/TTL accounting', () => {
      vi.useFakeTimers();
      const id = identity('conv-release', 'batch-rich');
      finishRichBatch(id, 1024);
      const store = useBatchProgressStore.getState();
      store.releaseBatchRichContent(id);
      store.releaseBatchRichContent(id);
      expect(batch(id).retainedRichBytes).toBe(0);
      expect(useBatchProgressStore.getState().richContentDiagnostics.totalRetainedRichBytes).toBe(0);
      expect(useBatchProgressStore.getState().richContentDiagnostics.releasedBatchCount).toBe(1);

      store.releaseViewLease(id);
      vi.advanceTimersByTime(BATCH_PROGRESS_COMPLETED_TTL_MS);
      expect(batch(id)).toBeUndefined();
      expect(useBatchProgressStore.getState().richContentDiagnostics.totalRetainedRichBytes).toBe(0);
    });

    it('marks admission omissions explicitly for exact-full first image plus second image', () => {
      const id = testIdentity('rich-admission-full');
      const store = useBatchProgressStore.getState();
      store.initBatch(id, ['A']);
      store.finishTaskStep(id, 0, {
        id: 'first-image',
        toolName: 'abu-browser__screenshot',
        result: 'first',
        resultContent: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a'.repeat(BATCH_PROGRESS_MAX_RICH_CONTENT_BYTES) } }],
        error: false,
      });
      store.finishTaskStep(id, 0, {
        id: 'second-image',
        toolName: 'abu-browser__screenshot',
        result: 'second',
        resultContent: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'b' } }],
        error: false,
      });

      const steps = batch(id).tasks[0].steps;
      expect(steps[0].richContentState).toBe('retained');
      expect(steps[1].richContentState).toBe('partially-retained');
      expect(steps[1].resultContent).toBeUndefined();
      expect(batch(id).retainedRichBytes).toBe(BATCH_PROGRESS_MAX_RICH_CONTENT_BYTES);
    });

    it('keeps later text when an oversized first block is omitted and marks partial retention', () => {
      const id = testIdentity('rich-admission-mixed');
      const store = useBatchProgressStore.getState();
      store.initBatch(id, ['A']);
      store.finishTaskStep(id, 0, {
        id: 'mixed',
        toolName: 'read_file',
        result: 'mixed',
        resultContent: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a'.repeat(BATCH_PROGRESS_MAX_RICH_CONTENT_BYTES + 1) } },
          { type: 'text', text: 'later text' },
        ],
        error: false,
      });

      const step = batch(id).tasks[0].steps[0];
      expect(step.richContentState).toBe('partially-retained');
      expect(step.resultContent).toEqual([{ type: 'text', text: 'later text' }]);
      expect(batch(id).retainedRichBytes).toBe(10);
    });

    it('marks partial UTF-8 text admission without corrupting emoji', () => {
      const full = testIdentity('rich-admission-utf8');
      const partialId = testIdentity('rich-admission-utf8-partial');
      const store = useBatchProgressStore.getState();
      store.initBatch(full, ['A']);
      store.finishTaskStep(full, 0, {
        id: 'utf8',
        toolName: 'read_file',
        result: 'utf8',
        resultContent: [{ type: 'text', text: 'a😀b' }],
        error: false,
      });

      const step = batch(full).tasks[0].steps[0];
      expect(step.richContentState).toBe('retained');
      expect(step.resultContent).toEqual([{ type: 'text', text: 'a😀b' }]);

      store.initBatch(partialId, ['A']);
      store.finishTaskStep(partialId, 0, {
        id: 'prefix',
        toolName: 'read_file',
        result: 'prefix',
        resultContent: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x'.repeat(BATCH_PROGRESS_MAX_RICH_CONTENT_BYTES - 3) } }],
        error: false,
      });
      store.finishTaskStep(partialId, 0, {
        id: 'utf8',
        toolName: 'read_file',
        result: 'utf8',
        resultContent: [{ type: 'text', text: 'a😀b' }],
        error: false,
      });
      const partial = batch(partialId).tasks[0].steps[1];
      expect(partial.richContentState).toBe('partially-retained');
      expect(partial.resultContent).toEqual([{ type: 'text', text: 'a' }]);
    });

    it('converges partially retained states to released during LRU reclaim', () => {
      const partial = identity('conv-partial-lru', 'batch-rich');
      const b = identity('conv-b-lru', 'batch-rich');
      const c = identity('conv-c-lru', 'batch-rich');
      const store = useBatchProgressStore.getState();
      store.initBatch(partial, ['A']);
      store.finishTaskStep(partial, 0, {
        id: 'first',
        toolName: 'abu-browser__screenshot',
        result: 'first',
        resultContent: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a'.repeat(BATCH_PROGRESS_MAX_RICH_CONTENT_BYTES) } }],
        error: false,
      });
      store.finishTaskStep(partial, 0, {
        id: 'second',
        toolName: 'abu-browser__screenshot',
        result: 'second',
        resultContent: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'b' } }],
        error: false,
      });
      store.setTaskTerminal(partial, 0, { status: 'succeeded', reason: 'completed' });
      finishRichBatch(b, BATCH_PROGRESS_MAX_RICH_CONTENT_BYTES);
      finishRichBatch(c, 1);

      expect(batch(partial).retainedRichBytes).toBe(0);
      expect(batch(partial).tasks[0].steps.map((step) => step.richContentState)).toEqual(['released', 'released']);
    });

    it('does not explicitly release running or active-visible rich content', () => {
      const running = identity('conv-explicit-running', 'batch-rich');
      const visible = identity('conv-explicit-visible', 'batch-rich');
      const store = useBatchProgressStore.getState();
      store.initBatch(running, ['A']);
      store.setTaskRunning(running, 0);
      store.finishTaskStep(running, 0, {
        id: 'running-rich',
        toolName: 'read_file',
        result: 'running',
        resultContent: [{ type: 'text', text: 'running rich' }],
        error: false,
      });
      store.releaseBatchRichContent(running);
      expect(batch(running).tasks[0].steps[0].richContentState).toBe('retained');
      expect(batch(running).retainedRichBytes).toBe(12);

      finishRichBatch(visible, 1024);
      store.setActiveVisibleBatch(visible);
      store.releaseBatchRichContent(visible);
      expect(batch(visible).tasks[0].steps[0].richContentState).toBe('retained');
      expect(batch(visible).retainedRichBytes).toBe(1024);
    });
  });
});
