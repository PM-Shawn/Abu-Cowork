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
} from './orchestrationTools';

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
