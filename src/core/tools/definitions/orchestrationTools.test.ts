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

import { describe, it, expect } from 'vitest';
import { clampConcurrency, runWithConcurrency, aggregateBatchResults } from './orchestrationTools';

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
});

// ─── aggregateBatchResults ────────────────────────────────────────────────

describe('aggregateBatchResults', () => {
  it('handles empty array', () => {
    const result = aggregateBatchResults([]);
    expect(result).toBe('共 0 个子任务，成功 0，失败 0');
  });

  it('ok-only: header shows all success, sections have no [失败] prefix', () => {
    const result = aggregateBatchResults([
      { label: '调研主题A', status: 'ok', text: '结果A' },
      { label: '调研主题B', status: 'ok', text: '结果B' },
    ]);
    expect(result).toContain('共 2 个子任务，成功 2，失败 0');
    expect(result).toContain('### 子任务 1: 调研主题A');
    expect(result).toContain('结果A');
    expect(result).toContain('### 子任务 2: 调研主题B');
    expect(result).toContain('结果B');
    expect(result).not.toContain('[失败]');
  });

  it('error-only: header shows all failures, sections have [失败] prefix', () => {
    const result = aggregateBatchResults([
      { label: '任务X', status: 'error', text: 'timeout' },
    ]);
    expect(result).toContain('共 1 个子任务，成功 0，失败 1');
    expect(result).toContain('### 子任务 1: 任务X');
    expect(result).toContain('[失败] timeout');
  });

  it('mixed: correct success/failure counts in header', () => {
    const result = aggregateBatchResults([
      { label: 'ok-task', status: 'ok', text: 'done' },
      { label: 'bad-task', status: 'error', text: 'crashed' },
      { label: 'ok-task2', status: 'ok', text: 'also done' },
    ]);
    expect(result).toContain('共 3 个子任务，成功 2，失败 1');
    expect(result).toContain('### 子任务 1: ok-task');
    expect(result).toContain('done');
    expect(result).toContain('### 子任务 2: bad-task');
    expect(result).toContain('[失败] crashed');
    expect(result).toContain('### 子任务 3: ok-task2');
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
    expect(result.startsWith('共 1 个子任务')).toBe(true);
  });
});
