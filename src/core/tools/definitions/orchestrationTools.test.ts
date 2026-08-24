/**
 * Tests for orchestrationTools.ts pure helpers.
 *
 * execute-level integration test note:
 * The `execute` function calls `runSubagentLoop`, which in turn instantiates
 * LLM adapters, Zustand stores, Tauri APIs, and Langfuse — all mocked globally
 * in src/test/setup.ts but without a clean injection seam in the current
 * runSubagentLoop signature. Wiring a `vi.mock('@/core/agent/subagentLoop')`
 * module mock would require hoisting and re-exporting SubagentResult, which
 * adds noise for little gain given the pure helpers already cover all the
 * logic. Execute-level coverage is therefore deferred to E2E / manual tests
 * and documented here as a deliberate trade-off (design note in design doc
 * §切片1: "只 import `runSubagentLoop`").
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  clampConcurrency,
  runWithConcurrency,
  runWithTimeout,
  aggregateBatchResults,
  aggregateStructuredResults,
  aggregateSubagentTextResults,
  resolveBatchStopReason,
  runAgentBatchTool,
  SUBAGENT_WALLCLOCK_TIMEOUT_MS,
} from './orchestrationTools';
import { SubagentResult } from '../../agent/subagentLoop';
import * as subagentRunner from '../../agent/subagentRunner';
import { useBatchProgressStore } from '../../../stores/batchProgressStore';
import { makeBatchKey, type BatchIdentity } from '../../../types';
import { clearLoopContext, setLoopContext } from '../../agent/permissionBridge';

function batchIdentity(conversationId: string, batchToolCallId: string): BatchIdentity {
  return { conversationId, batchToolCallId };
}

function batch(identity: BatchIdentity) {
  return useBatchProgressStore.getState().batches[makeBatchKey(identity)];
}

function subagentResult(text: string, stopReason: 'completed' | 'aborted' | 'error' | 'max_turns') {
  return new SubagentResult({
    text,
    stopReason,
    toolCallCount: 0,
    turnCount: 1,
    tokenUsage: { input: 0, output: 0 },
    duration: 0,
  });
}

describe('runAgentBatchTool preset boundaries', () => {
  it('describes the fixed tool boundaries of built-in role presets', () => {
    const tasks = runAgentBatchTool.inputSchema.properties.tasks as {
      items: { properties: { type: { description: string } } };
    };
    const description = tasks.items.properties.type.description;
    expect(description).toContain('research (lookup-focused: file reads, search, web and general HTTP requests)');
    expect(description).toContain('writer (content authoring: read/write/edit files plus web search)');
    expect(description).toContain('executor (full toolset — includes browser, image and MCP tools)');
  });
});

describe('runAgentBatchTool progress wiring', () => {
  beforeEach(() => {
    useBatchProgressStore.setState({ batches: {} });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    clearLoopContext('loop-parent-abort');
    for (const batchId of Object.keys(useBatchProgressStore.getState().batches)) {
      useBatchProgressStore.getState().clearBatch(batchId);
    }
  });

  it('retains tool-end rich content and cumulative progress usage in the batch store', async () => {
    const image = [{ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'aGk=' } }];
    vi.spyOn(subagentRunner, 'runSubagent').mockImplementation(async (options) => {
      options.onProgress?.({ type: 'tool-start', id: 'sub-tool-1', toolName: 'abu-browser__screenshot', toolInput: { fullPage: true } });
      options.onProgress?.({ type: 'tool-end', id: 'sub-tool-1', toolName: 'abu-browser__screenshot', result: 'Screenshot', resultContent: image, error: false });
      options.onProgress?.({ type: 'turn-complete', turn: 1, totalTurns: 20, usage: { inputTokens: 120, outputTokens: 45 } });
      return new SubagentResult({
        text: 'done',
        stopReason: 'completed',
        toolCallCount: 1,
        turnCount: 2,
        tokenUsage: { input: 120, output: 45 },
        duration: 1,
      });
    });

    await runAgentBatchTool.execute(
      { tasks: [{ type: 'executor', task: 'capture the page' }] },
      { conversationId: 'conv-progress', toolCallId: 'batch-progress' },
    );

    const task = batch(batchIdentity('conv-progress', 'batch-progress')).tasks[0];
    expect(task.status).toBe('succeeded');
    expect(task.toolCallCount).toBe(1);
    expect(task.lastToolName).toBe('abu-browser__screenshot');
    expect(task.tokenUsage).toEqual({ inputTokens: 120, outputTokens: 45 });
    expect(task.steps[0]).toMatchObject({
      id: 'sub-tool-1',
      result: 'Screenshot',
      resultContent: image,
      status: 'completed',
    });
  });

  it('uses terminal counters when no progress event is emitted', async () => {
    vi.spyOn(subagentRunner, 'runSubagent').mockResolvedValue(new SubagentResult({
      text: 'direct answer',
      toolCallCount: 3,
      turnCount: 1,
      tokenUsage: { input: 90, output: 30 },
      duration: 1,
      stopReason: 'completed',
    }));

    await runAgentBatchTool.execute(
      { tasks: [{ type: 'executor', task: 'answer directly' }] },
      { conversationId: 'conv-terminal-usage', toolCallId: 'batch-terminal-usage' },
    );

    const task = batch(batchIdentity('conv-terminal-usage', 'batch-terminal-usage')).tasks[0];
    expect(task.status).toBe('succeeded');
    expect(task.toolCallCount).toBe(3);
    expect(task.tokenUsage).toEqual({ inputTokens: 90, outputTokens: 30 });
  });

  it('marks the progress row failed when structured output validation fails', async () => {
    vi.spyOn(subagentRunner, 'runSubagent').mockResolvedValue(new SubagentResult({
      text: 'not json',
      toolCallCount: 0,
      turnCount: 1,
      tokenUsage: { input: 50, output: 10 },
      duration: 1,
      stopReason: 'completed',
    }));

    const output = await runAgentBatchTool.execute(
      {
        tasks: [{ type: 'executor', task: 'return structured data' }],
        schema: { type: 'object', required: ['name'] },
      },
      { conversationId: 'conv-invalid-structured', toolCallId: 'batch-invalid-structured' },
    );

    expect(batch(batchIdentity('conv-invalid-structured', 'batch-invalid-structured')).tasks[0].status)
      .toBe('failed');
    expect(batch(batchIdentity('conv-invalid-structured', 'batch-invalid-structured')).tasks[0].terminalReason)
      .toBe('invalid_structured');
    expect(JSON.parse(output)[0]).toMatchObject({ ok: false });
  });

  it('preserves a structured child abort instead of overwriting it as invalid_structured', async () => {
    vi.spyOn(subagentRunner, 'runSubagent').mockResolvedValue(new SubagentResult({
      text: 'not json',
      toolCallCount: 0,
      turnCount: 1,
      tokenUsage: { input: 50, output: 10 },
      duration: 1,
      stopReason: 'aborted',
    }));

    await runAgentBatchTool.execute(
      {
        tasks: [{ type: 'executor', task: 'return structured data' }],
        schema: { type: 'object', required: ['name'] },
      },
      { conversationId: 'conv-aborted-structured', toolCallId: 'batch-aborted-structured' },
    );

    const task = batch(batchIdentity('conv-aborted-structured', 'batch-aborted-structured')).tasks[0];
    expect(task.status).toBe('stopped');
    expect(task.terminalReason).toBe('aborted');
  });

  it('checkpoints a minimal batch terminal summary through trusted metadata', async () => {
    vi.spyOn(subagentRunner, 'runSubagent')
      .mockResolvedValueOnce(new SubagentResult({
        text: 'ok',
        toolCallCount: 0,
        turnCount: 1,
        tokenUsage: { input: 1, output: 2 },
        duration: 1,
        stopReason: 'completed',
      }))
      .mockResolvedValueOnce(new SubagentResult({
        text: 'partial',
        toolCallCount: 0,
        turnCount: 1,
        tokenUsage: { input: 3, output: 4 },
        duration: 1,
        stopReason: 'max_turns',
      }));
    const reportMetadata = vi.fn();

    await runAgentBatchTool.execute(
      { tasks: [{ type: 'executor', task: 'one' }, { type: 'executor', task: 'two' }] },
      { conversationId: 'conv-summary', toolCallId: 'batch-summary', reportMetadata },
    );

    expect(reportMetadata).toHaveBeenCalledWith({
      batchTerminalSummary: {
        version: 1,
        batch: { conversationId: 'conv-summary', batchToolCallId: 'batch-summary' },
        taskCount: 2,
        counts: { succeeded: 1, failed: 0, stopped: 0, incomplete: 1 },
        tasks: [
          { taskIndex: 0, status: 'succeeded', terminalReason: 'completed' },
          { taskIndex: 1, status: 'incomplete', terminalReason: 'max_turns' },
        ],
      },
    });
  });

  it('marks parent-aborted unclaimed tasks as stopped without flattening completed siblings', async () => {
    const controller = new AbortController();
    setLoopContext('loop-parent-abort', {
      commandConfirmCallback: async () => true,
      filePermissionCallback: async () => true,
      signal: controller.signal,
      eventRouter: { route: vi.fn() } as never,
      loopId: 'loop-parent-abort',
      conversationId: 'conv-parent-abort',
      toolCallToStepId: new Map(),
    });
    vi.spyOn(subagentRunner, 'runSubagent').mockImplementation(async () => {
      controller.abort();
      return new SubagentResult({
        text: 'first completed',
        toolCallCount: 0,
        turnCount: 1,
        tokenUsage: { input: 1, output: 1 },
        duration: 1,
        stopReason: 'completed',
      });
    });

    await runAgentBatchTool.execute(
      {
        tasks: [{ type: 'executor', task: 'claimed' }, { type: 'executor', task: 'unclaimed' }],
        concurrency: 1,
      },
      { conversationId: 'conv-parent-abort', toolCallId: 'batch-parent-abort', loopId: 'loop-parent-abort' },
    );

    const tasks = batch(batchIdentity('conv-parent-abort', 'batch-parent-abort')).tasks;
    expect(tasks[0].status).toBe('succeeded');
    expect(tasks[1].status).toBe('stopped');
    expect(tasks[1].startedAt).toBeUndefined();
  });

  it('checkpoints parent-aborted queued tasks immediately while a non-cooperative running child is still pending', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    setLoopContext('loop-parent-abort', {
      commandConfirmCallback: async () => true,
      filePermissionCallback: async () => true,
      signal: controller.signal,
      eventRouter: { route: vi.fn() } as never,
      loopId: 'loop-parent-abort',
      conversationId: 'conv-parent-abort',
      toolCallToStepId: new Map(),
    });
    vi.spyOn(subagentRunner, 'runSubagent').mockImplementation(async (options) => {
      if (options.task.startsWith('running')) {
        return new Promise(() => {});
      }
      controller.abort();
      return new SubagentResult({
        text: 'aborter completed',
        toolCallCount: 0,
        turnCount: 1,
        tokenUsage: { input: 1, output: 1 },
        duration: 1,
        stopReason: 'completed',
      });
    });
    const reportMetadata = vi.fn();
    let settled = false;

    const run = runAgentBatchTool.execute(
      {
        tasks: [
          { type: 'executor', task: 'running non-cooperative' },
          { type: 'executor', task: 'aborter' },
          { type: 'executor', task: 'queued' },
        ],
        concurrency: 2,
      },
      {
        conversationId: 'conv-parent-abort-immediate',
        toolCallId: 'batch-parent-abort-immediate',
        loopId: 'loop-parent-abort',
        reportMetadata,
      },
    ).then((value) => {
      settled = true;
      return value;
    });

    await Promise.resolve();
    await Promise.resolve();

    const tasks = batch(batchIdentity('conv-parent-abort-immediate', 'batch-parent-abort-immediate')).tasks;
    expect(tasks[2].status).toBe('stopped');
    expect(tasks[2].startedAt).toBeUndefined();
    expect(settled).toBe(false);
    expect(subagentRunner.runSubagent).toHaveBeenCalledTimes(2);
    expect(reportMetadata).toHaveBeenCalledWith({
      batchTerminalSummary: expect.objectContaining({
        taskCount: 3,
        counts: { succeeded: 0, failed: 0, stopped: 1, incomplete: 0 },
        tasks: [{ taskIndex: 2, status: 'stopped', terminalReason: 'aborted' }],
      }),
    });

    await vi.advanceTimersByTimeAsync(SUBAGENT_WALLCLOCK_TIMEOUT_MS);
    await run;
  });

  it('marks a wall-clock timeout as a failed task with timeout reason', async () => {
    vi.useFakeTimers();
    vi.spyOn(subagentRunner, 'runSubagent').mockImplementation(() => new Promise(() => {}));

    const run = runAgentBatchTool.execute(
      { tasks: [{ type: 'executor', task: 'hang' }] },
      { conversationId: 'conv-timeout', toolCallId: 'batch-timeout' },
    );
    await vi.advanceTimersByTimeAsync(SUBAGENT_WALLCLOCK_TIMEOUT_MS);
    await run;

    const task = batch(batchIdentity('conv-timeout', 'batch-timeout')).tasks[0];
    expect(task.status).toBe('failed');
    expect(task.terminalReason).toBe('timeout');
  });
});

describe('structured subagent terminal aggregation', () => {
  it('treats completed Error-prefixed text as success and plain error text as failure', () => {
    const output = aggregateSubagentTextResults([
      { status: 'fulfilled', value: subagentResult('Error: quoted log heading', 'completed') },
      { status: 'fulfilled', value: subagentResult('stopped before finishing', 'error') },
    ], ['quoted report', 'failed report']);

    expect(output).toContain('2 sub-tasks total: 1 succeeded, 1 failed');
    expect(output).toContain('Error: quoted log heading');
    expect(output).toContain('[Failed] stopped before finishing');
  });

  it('aggregates mixed terminal reasons with deterministic failure priority', () => {
    const makeSummary = (tasks: Array<{ taskIndex: number; status: 'succeeded' | 'failed' | 'stopped' | 'incomplete'; terminalReason: 'completed' | 'error' | 'aborted' | 'max_turns' }>) => ({
      version: 1 as const,
      batch: { conversationId: 'conv-stop', batchToolCallId: 'batch-stop' },
      taskCount: tasks.length,
      counts: {
        succeeded: tasks.filter((task) => task.status === 'succeeded').length,
        failed: tasks.filter((task) => task.status === 'failed').length,
        stopped: tasks.filter((task) => task.status === 'stopped').length,
        incomplete: tasks.filter((task) => task.status === 'incomplete').length,
      },
      tasks,
    });

    expect(resolveBatchStopReason(makeSummary([{ taskIndex: 0, status: 'succeeded', terminalReason: 'completed' }]))).toBe('completed');
    expect(resolveBatchStopReason(makeSummary([
      { taskIndex: 0, status: 'succeeded', terminalReason: 'completed' },
      { taskIndex: 1, status: 'incomplete', terminalReason: 'max_turns' },
    ]))).toBe('max_turns');
    expect(resolveBatchStopReason(makeSummary([
      { taskIndex: 0, status: 'incomplete', terminalReason: 'max_turns' },
      { taskIndex: 1, status: 'stopped', terminalReason: 'aborted' },
    ]))).toBe('aborted');
    expect(resolveBatchStopReason(makeSummary([
      { taskIndex: 0, status: 'stopped', terminalReason: 'aborted' },
      { taskIndex: 1, status: 'failed', terminalReason: 'error' },
    ]))).toBe('error');
  });
});

// ─── clampConcurrency ──────────────────────────────────────────────────────

describe('clampConcurrency', () => {
  it('returns 4 for undefined', () => {
    expect(clampConcurrency(undefined)).toBe(4);
  });

  it('returns 4 for null', () => {
    expect(clampConcurrency(null)).toBe(4);
  });

  it('returns 4 for a string', () => {
    expect(clampConcurrency('high')).toBe(4);
  });

  it('returns 4 for NaN', () => {
    expect(clampConcurrency(NaN)).toBe(4);
  });

  it('returns 4 for Infinity', () => {
    expect(clampConcurrency(Infinity)).toBe(4);
  });

  it('returns default 4 for exact 4', () => {
    expect(clampConcurrency(4)).toBe(4);
  });

  it('clamps below-minimum to 1', () => {
    expect(clampConcurrency(0)).toBe(1);
    expect(clampConcurrency(-5)).toBe(1);
  });

  it('clamps above-maximum to 8', () => {
    expect(clampConcurrency(9)).toBe(8);
    expect(clampConcurrency(100)).toBe(8);
  });

  it('accepts valid values within range', () => {
    expect(clampConcurrency(1)).toBe(1);
    expect(clampConcurrency(3)).toBe(3);
    expect(clampConcurrency(8)).toBe(8);
  });

  it('floors floating-point values', () => {
    expect(clampConcurrency(2.9)).toBe(2);
    expect(clampConcurrency(7.1)).toBe(7);
  });
});

// ─── runWithConcurrency ────────────────────────────────────────────────────

describe('runWithConcurrency', () => {
  it('runs all items and returns results', async () => {
    const items = [1, 2, 3];
    const results = await runWithConcurrency(items, 2, async (n) => n * 10);
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ status: 'fulfilled', value: 10 });
    expect(results[1]).toEqual({ status: 'fulfilled', value: 20 });
    expect(results[2]).toEqual({ status: 'fulfilled', value: 30 });
  });

  it('preserves result order regardless of completion order', async () => {
    // Item at index 1 resolves first (microtask-level), index 0 resolves second
    const order: number[] = [];
    const items = [50, 0, 30]; // "delay" in microtask iterations

    const results = await runWithConcurrency(items, 3, async (delayTicks, index) => {
      // Yield `delayTicks` microtasks to simulate ordering
      for (let i = 0; i < delayTicks; i++) {
        await Promise.resolve();
      }
      order.push(index);
      return index;
    });

    // Results must be in index order regardless of completion order
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : -1))).toEqual([0, 1, 2]);
    // The zero-delay item (index 1) should have finished first
    expect(order[0]).toBe(1);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let maxObservedInFlight = 0;
    const items = Array.from({ length: 8 }, (_, i) => i);

    await runWithConcurrency(items, 3, async () => {
      inFlight++;
      if (inFlight > maxObservedInFlight) maxObservedInFlight = inFlight;
      // Yield to allow other workers to start before we decrement
      await Promise.resolve();
      inFlight--;
    });

    expect(maxObservedInFlight).toBeLessThanOrEqual(3);
  });

  it('produces rejected settled results when fn throws (does not propagate)', async () => {
    const items = ['a', 'b', 'c'];
    const results = await runWithConcurrency(items, 2, async (item) => {
      if (item === 'b') throw new Error('boom');
      return item.toUpperCase();
    });

    expect(results[0]).toEqual({ status: 'fulfilled', value: 'A' });
    expect(results[1].status).toBe('rejected');
    if (results[1].status === 'rejected') {
      expect((results[1].reason as Error).message).toBe('boom');
    }
    expect(results[2]).toEqual({ status: 'fulfilled', value: 'C' });
  });

  it('handles empty items array', async () => {
    const results = await runWithConcurrency([], 4, async (n: number) => n);
    expect(results).toHaveLength(0);
  });

  it('handles limit larger than items count without error', async () => {
    const items = [1, 2];
    const results = await runWithConcurrency(items, 10, async (n) => n + 1);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ status: 'fulfilled', value: 2 });
    expect(results[1]).toEqual({ status: 'fulfilled', value: 3 });
  });

  it('passes correct index to fn', async () => {
    const items = ['x', 'y', 'z'];
    const captured: Array<[string, number]> = [];
    await runWithConcurrency(items, 2, async (item, index) => {
      captured.push([item, index]);
    });
    expect(captured).toContainEqual(['x', 0]);
    expect(captured).toContainEqual(['y', 1]);
    expect(captured).toContainEqual(['z', 2]);
  });

  it('stops claiming new items after signal is aborted, fills remaining slots as rejected', async () => {
    // Concurrency 1, 3 items. Item 0's fn aborts the controller, so items 1
    // and 2 should never be started. The returned array must still be length 3
    // with indices 1 and 2 as rejected settled results.
    const controller = new AbortController();
    const invoked: number[] = [];

    const results = await runWithConcurrency(
      [0, 1, 2],
      1,
      async (_item, index) => {
        invoked.push(index);
        if (index === 0) {
          // Abort right after item 0 finishes — queued items should not start.
          controller.abort();
        }
        return index;
      },
      controller.signal,
    );

    // fn must have been called for index 0 only
    expect(invoked).toEqual([0]);
    expect(invoked).not.toContain(1);
    expect(invoked).not.toContain(2);

    // Array must be fully populated (no holes)
    expect(results).toHaveLength(3);

    // Index 0 succeeded
    expect(results[0]).toEqual({ status: 'fulfilled', value: 0 });

    // Indices 1 and 2 were never started — must be rejected with the cancel error
    expect(results[1].status).toBe('rejected');
    expect(results[2].status).toBe('rejected');
    if (results[1].status === 'rejected') {
      expect((results[1].reason as Error).message).toBe('Cancelled');
    }
    if (results[2].status === 'rejected') {
      expect((results[2].reason as Error).message).toBe('Cancelled');
    }
  });
});

// ─── aggregateBatchResults ────────────────────────────────────────────────

describe('aggregateBatchResults', () => {
  it('handles empty array', () => {
    const result = aggregateBatchResults([]);
    expect(result).toBe('0 sub-tasks total: 0 succeeded, 0 failed');
  });

  it('ok-only: header shows all success, sections have no [Failed] prefix', () => {
    const result = aggregateBatchResults([
      { label: 'Topic A', status: 'ok', text: 'Result A' },
      { label: 'Topic B', status: 'ok', text: 'Result B' },
    ]);
    expect(result).toContain('2 sub-tasks total: 2 succeeded, 0 failed');
    expect(result).toContain('### Sub-task 1: Topic A');
    expect(result).toContain('Result A');
    expect(result).toContain('### Sub-task 2: Topic B');
    expect(result).toContain('Result B');
    expect(result).not.toContain('[Failed]');
  });

  it('error-only: header shows all failures, sections have [Failed] prefix', () => {
    const result = aggregateBatchResults([
      { label: 'Task X', status: 'error', text: 'timeout' },
    ]);
    expect(result).toContain('1 sub-tasks total: 0 succeeded, 1 failed');
    expect(result).toContain('### Sub-task 1: Task X');
    expect(result).toContain('[Failed] timeout');
  });

  it('mixed: correct success/failure counts in header', () => {
    const result = aggregateBatchResults([
      { label: 'ok-task', status: 'ok', text: 'done' },
      { label: 'bad-task', status: 'error', text: 'crashed' },
      { label: 'ok-task2', status: 'ok', text: 'also done' },
    ]);
    expect(result).toContain('3 sub-tasks total: 2 succeeded, 1 failed');
    expect(result).toContain('### Sub-task 1: ok-task');
    expect(result).toContain('done');
    expect(result).toContain('### Sub-task 2: bad-task');
    expect(result).toContain('[Failed] crashed');
    expect(result).toContain('### Sub-task 3: ok-task2');
    expect(result).toContain('also done');
  });

  it('sections are separated by blank lines', () => {
    const result = aggregateBatchResults([
      { label: 'A', status: 'ok', text: 'alpha' },
      { label: 'B', status: 'ok', text: 'beta' },
    ]);
    // The separator between header and first section, and between sections
    expect(result).toContain('\n\n');
  });

  it('header is the first line of output', () => {
    const result = aggregateBatchResults([{ label: 'X', status: 'ok', text: 'out' }]);
    expect(result.startsWith('1 sub-tasks total')).toBe(true);
  });
});

// ─── aggregateStructuredResults ───────────────────────────────────────────

describe('aggregateStructuredResults', () => {
  it('returns a valid JSON array string', () => {
    const entries = [
      { task: 'invoice 1', ok: true, data: { vendor: 'Acme', amount: 100 } },
      { task: 'invoice 2', ok: false, error: '未能解析出匹配的 JSON' },
    ];
    const result = aggregateStructuredResults(entries);
    const parsed: unknown = JSON.parse(result);
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('preserves all fields for ok:true entries', () => {
    const entries = [{ task: 'task A', ok: true, data: { vendor: 'Beta', amount: 200 } }];
    const result = aggregateStructuredResults(entries);
    const parsed = JSON.parse(result) as Array<{ task: string; ok: boolean; data: { vendor: string; amount: number } }>;
    expect(parsed[0].task).toBe('task A');
    expect(parsed[0].ok).toBe(true);
    expect(parsed[0].data).toEqual({ vendor: 'Beta', amount: 200 });
  });

  it('preserves all fields for ok:false entries', () => {
    const entries = [{ task: 'task B', ok: false, error: '缺少必填字段: amount' }];
    const result = aggregateStructuredResults(entries);
    const parsed = JSON.parse(result) as Array<{ task: string; ok: boolean; error: string }>;
    expect(parsed[0].task).toBe('task B');
    expect(parsed[0].ok).toBe(false);
    expect(parsed[0].error).toBe('缺少必填字段: amount');
  });

  it('returns a pretty-printed (indented) JSON string', () => {
    const result = aggregateStructuredResults([{ task: 't', ok: true, data: {} }]);
    // Pretty-print means at least one newline and indentation
    expect(result).toContain('\n');
    expect(result).toContain('  ');
  });

  it('handles an empty entries array', () => {
    const result = aggregateStructuredResults([]);
    expect(JSON.parse(result)).toEqual([]);
  });

  it('preserves order of entries', () => {
    const entries = [
      { task: 'first', ok: true, data: { n: 1 } },
      { task: 'second', ok: false, error: 'oops' },
      { task: 'third', ok: true, data: { n: 3 } },
    ];
    const result = aggregateStructuredResults(entries);
    const parsed = JSON.parse(result) as Array<{ task: string }>;
    expect(parsed.map((e) => e.task)).toEqual(['first', 'second', 'third']);
  });
});

// ─── runWithTimeout ───────────────────────────────────────────────────────────

describe('runWithTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('(a) resolves with factory value when factory completes before timeout', async () => {
    const result = await runWithTimeout(
      async (_sig) => 'done',
      5000,
    );
    expect(result).toBe('done');
  });

  it('(b) rejects with timeout error after timeoutMs, and aborts the factory signal', async () => {
    let capturedSignal: AbortSignal | undefined;

    const racePromise = runWithTimeout(
      (sig) => {
        capturedSignal = sig;
        // Factory never resolves
        return new Promise<never>(() => {});
      },
      5000,
    );

    // Pre-attach the rejection handler BEFORE advancing the timer so the
    // promise is always "handled" when the timeout fires. Advancing the timer
    // AFTER attaching avoids Vitest / Node unhandledRejection events.
    const assertion = expect(racePromise).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('(b) error message contains the full timeout string', async () => {
    const racePromise = runWithTimeout(
      () => new Promise<never>(() => {}),
      3000,
    );
    // Pre-attach before advancing timer.
    const assertion = expect(racePromise).rejects.toThrow('Sub-agent execution timed out (aborted)');
    await vi.advanceTimersByTimeAsync(3000);
    await assertion;
  });

  it('(c) already-aborted parentSignal aborts the factory signal immediately', async () => {
    const parent = new AbortController();
    parent.abort();

    let capturedSignal: AbortSignal | undefined;
    // Factory resolves quickly once the signal is aborted — we just capture the signal
    const promise = runWithTimeout(
      (sig) => {
        capturedSignal = sig;
        return Promise.resolve('value');
      },
      5000,
      parent.signal,
    );

    await promise;
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('(c) parent abort fired after start propagates to factory signal', async () => {
    const parent = new AbortController();
    let capturedSignal: AbortSignal | undefined;

    const promise = runWithTimeout(
      (sig) => {
        capturedSignal = sig;
        return new Promise<never>(() => {});
      },
      60000,
      parent.signal,
    );

    // Factory is still pending — trigger parent abort now
    parent.abort();

    // The timeout (60s) hasn't fired; the race should still be pending here,
    // but the captured signal must already be aborted.
    expect(capturedSignal?.aborted).toBe(true);

    // Pre-attach the rejection handler BEFORE advancing the timer to avoid
    // Vitest / Node unhandledRejection events when the 60s timeout fires.
    const catchPromise = promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(60000);
    await catchPromise;
  });
});
