/**
 * The batch executor: ordering, page identity between steps, and stopping.
 *
 * The transport here records what actually went out and what was in flight at
 * the same time, because the two properties that matter most are negative
 * ones: after a batch stops, NOTHING further is sent (a stop that still fires
 * the remaining steps is the failure mode this whole module exists to
 * prevent), and an action is never dispatched alongside anything else.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_BATCH_DURATION_MS,
  MAX_BATCH_STEP_RESULT_CHARS,
  batchOrigin,
  parseBatchSteps,
  runBatch,
  type BatchDeps,
} from './batch.js';
import type { BatchStep } from './types.js';

const TAB = 7;

interface Harness {
  deps: BatchDeps;
  /** Every action sent, in dispatch order, `get_tabs` probes included. */
  sent: string[];
  /** Page actions only — what the page actually had done to it. */
  actions: string[];
  /** For each completed send, everything that was in flight beside it. */
  concurrency: string[][];
}

interface HarnessOptions {
  /** Tab URL by probe number; the last entry repeats. */
  urls?: string[];
  /** Actions that fail, by index among page actions. */
  failAt?: number;
  /** Result payload for a given action, defaults to a small ok object. */
  resultFor?: (action: string, nth: number) => unknown;
  /** ms the injected clock advances per read. */
  tick?: number;
}

function harness(options: HarnessOptions = {}): Harness {
  const urls = options.urls ?? ['https://erp.example.com/form'];
  const sent: string[] = [];
  const actions: string[] = [];
  const concurrency: string[][] = [];
  const inFlight = new Map<number, string>();
  let probe = 0;
  let key = 0;
  let clock = 0;

  const deps: BatchDeps = {
    now: () => {
      clock += options.tick ?? 1;
      return clock;
    },
    send: async (action) => {
      sent.push(action);
      if (action === 'get_tabs') {
        const url = urls[Math.min(probe, urls.length - 1)];
        probe += 1;
        return { success: true, data: { windows: [{ tabs: [{ tabId: TAB, url }] }] } };
      }
      const nth = actions.length;
      actions.push(action);
      const id = key++;
      inFlight.set(id, action);
      // Two microtask yields: every sibling dispatched in the same Promise.all
      // tick has already registered by the time this snapshot is taken.
      await Promise.resolve();
      await Promise.resolve();
      concurrency.push([...inFlight.values()].sort());
      inFlight.delete(id);
      if (options.failAt === nth) return { success: false, error: 'Element not found: #missing' };
      return { success: true, data: options.resultFor?.(action, nth) ?? { success: true, message: 'ok' } };
    },
  };
  return { deps, sent, actions, concurrency };
}

function steps(...list: Array<BatchStep['action']>): BatchStep[] {
  return list.map((action) => {
    switch (action) {
      case 'fill':
      case 'select':
        return { action, locator: { css: '#a' }, value: 'v' };
      case 'click':
        return { action, locator: { css: '#a' } };
      case 'keyboard':
        return { action, key: 'Enter' };
      case 'wait_for':
        return { action, condition: { type: 'appear', locator: { css: '#a' } } };
      case 'find':
        return { action, query: { role: 'button' } };
      case 'read':
        return { action, selector: '#out' };
    }
  });
}

describe('runBatch — ordering and completion', () => {
  it('runs every step in order and reports nothing left', async () => {
    const h = harness();
    const result = await runBatch(h.deps, TAB, steps('fill', 'fill', 'click', 'wait_for'));

    expect(h.actions).toEqual(['fill', 'fill', 'click', 'wait_for']);
    expect(result.completedSteps.map((s) => s.index)).toEqual([0, 1, 2, 3]);
    expect(result.remainingSteps).toBe(0);
    expect(result.failedStep).toBeUndefined();
    expect(result.stopped).toBeUndefined();
    expect(result.origin).toBe('https://erp.example.com');
  });

  it('gives a wait step the same transport headroom the single wait_for tool gives it', async () => {
    const timeouts: Array<number | undefined> = [];
    const deps: BatchDeps = {
      now: () => 0,
      send: async (action, _payload, timeoutMs) => {
        if (action === 'get_tabs') {
          return { success: true, data: { windows: [{ tabs: [{ tabId: TAB, url: 'https://a.example' }] }] } };
        }
        timeouts.push(timeoutMs);
        return { success: true, data: {} };
      },
    };
    await runBatch(deps, TAB, [
      { action: 'click', locator: { css: '#a' } },
      { action: 'wait_for', condition: { type: 'appear', locator: { css: '#a' } }, timeout: 10_000 },
    ]);
    expect(timeouts).toEqual([undefined, 15_000]);
  });
});

describe('runBatch — stopping at the first failure', () => {
  it('stops on the failed step and never attempts what comes after it', async () => {
    const h = harness({ failAt: 1 });
    const result = await runBatch(h.deps, TAB, steps('fill', 'fill', 'click', 'click'));

    expect(h.actions).toEqual(['fill', 'fill']);
    expect(result.completedSteps.map((s) => s.index)).toEqual([0]);
    expect(result.failedStep).toMatchObject({ index: 1, action: 'fill', ok: false });
    expect(result.failedStep?.error).toContain('Element not found');
    expect(result.remainingSteps).toBe(2);
    expect(result.stopped).toBe('step-failed');
    expect(result.message).toMatch(/1 of 4 steps ran/);
  });

  it('does not retry the step that failed', async () => {
    const h = harness({ failAt: 0 });
    await runBatch(h.deps, TAB, steps('click', 'click'));
    expect(h.actions).toEqual(['click']);
  });

  it('reports a transport that throws as that step failing, not as the tool crashing', async () => {
    const deps: BatchDeps = {
      now: () => 0,
      send: async (action) => {
        if (action === 'get_tabs') {
          return { success: true, data: { windows: [{ tabs: [{ tabId: TAB, url: 'https://a.example' }] }] } };
        }
        throw new Error('The user is currently interacting with this browser tab.');
      },
    };
    const result = await runBatch(deps, TAB, steps('click', 'click'));
    expect(result.stopped).toBe('step-failed');
    expect(result.failedStep?.error).toMatch(/currently interacting/);
  });
});

describe('runBatch — page identity between steps', () => {
  it('keeps going when the page navigates WITHIN the same origin', async () => {
    // Submitting a form and landing on its own results page is not a drift.
    const h = harness({
      urls: [
        'https://erp.example.com/form',
        'https://erp.example.com/form',
        'https://erp.example.com/result?id=9',
      ],
    });
    const result = await runBatch(h.deps, TAB, steps('fill', 'click', 'read'));

    expect(h.actions).toEqual(['fill', 'click', 'extract_text']);
    expect(result.stopped).toBeUndefined();
  });

  it('stops the moment the tab leaves the origin the batch was approved for', async () => {
    const h = harness({
      urls: [
        'https://erp.example.com/form',
        'https://erp.example.com/form',
        'https://login.evil.example/oauth',
      ],
    });
    const result = await runBatch(h.deps, TAB, steps('fill', 'click', 'fill', 'click'));

    // The two steps that would have run on the OTHER site never went out.
    expect(h.actions).toEqual(['fill', 'click']);
    expect(result.stopped).toBe('origin-changed');
    expect(result.remainingSteps).toBe(2);
    expect(result.failedStep).toBeUndefined();
    expect(result.origin).toBe('https://erp.example.com');
    expect(result.message).toMatch(/https:\/\/erp\.example\.com/);
  });

  it('treats an origin it cannot read as a stop, not as "carry on"', async () => {
    const h = harness({ urls: ['https://erp.example.com/form', 'about:blank'] });
    const result = await runBatch(h.deps, TAB, steps('click', 'click'));

    expect(h.actions).toEqual(['click']);
    expect(result.stopped).toBe('origin-unverifiable');
  });

  it('runs nothing at all when the origin cannot be read before the first step', async () => {
    const h = harness({ urls: ['about:blank'] });
    const result = await runBatch(h.deps, TAB, steps('click', 'click'));

    expect(h.actions).toEqual([]);
    expect(result.stopped).toBe('origin-unverifiable');
    expect(result.remainingSteps).toBe(2);
  });

  it('re-reads the origin before every step instead of trusting the pin', async () => {
    const h = harness();
    await runBatch(h.deps, TAB, steps('click', 'click', 'click'));
    // One probe to pin, then one before each step after the first.
    expect(h.sent.filter((a) => a === 'get_tabs')).toHaveLength(3);
  });

  it('never opens a tab while checking which page it is on', async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const deps: BatchDeps = {
      now: () => 0,
      send: async (action, payload) => {
        if (action === 'get_tabs') {
          payloads.push(payload);
          return { success: true, data: { windows: [{ tabs: [{ tabId: TAB, url: 'https://a.example' }] }] } };
        }
        return { success: true, data: {} };
      },
    };
    await runBatch(deps, TAB, steps('click'));
    expect(payloads.every((p) => p.createIfEmpty === false)).toBe(true);
  });
});

describe('runBatch — what may run beside what', () => {
  it('dispatches consecutive read steps together', async () => {
    const h = harness();
    await runBatch(h.deps, TAB, steps('find', 'read', 'find'));
    // All three were in flight at once.
    expect(h.concurrency[0]).toEqual(['extract_text', 'find', 'find']);
  });

  it('never lets an action share the page with anything else', async () => {
    const h = harness();
    await runBatch(h.deps, TAB, steps('find', 'read', 'fill', 'find', 'click'));

    for (const snapshot of h.concurrency) {
      const hasAction = snapshot.some((a) => a === 'fill' || a === 'click');
      if (hasAction) expect(snapshot).toHaveLength(1);
    }
    expect(h.actions).toEqual(['find', 'extract_text', 'fill', 'find', 'click']);
  });

  it('keeps waits sequential — a wait is about when it happens', async () => {
    const h = harness();
    await runBatch(h.deps, TAB, steps('wait_for', 'wait_for'));
    for (const snapshot of h.concurrency) expect(snapshot).toHaveLength(1);
  });
});

describe('runBatch — bounds', () => {
  it('stops when the run has been going longer than one approval should cover', async () => {
    // Clock advances a quarter of the budget per read, so the first step runs
    // and the check before the second one trips.
    const h = harness({ tick: MAX_BATCH_DURATION_MS / 4 });
    const result = await runBatch(h.deps, TAB, steps('click', 'click', 'click'));
    expect(h.actions).toEqual(['click']);
    expect(result.stopped).toBe('time-limit');
    expect(result.remainingSteps).toBe(2);
  });

  it('cuts an oversized step result rather than letting the envelope be shredded', async () => {
    const huge = 'x'.repeat(MAX_BATCH_STEP_RESULT_CHARS * 2);
    const h = harness({ resultFor: (action) => (action === 'extract_text' ? huge : { ok: true }) });
    const result = await runBatch(h.deps, TAB, steps('read', 'click'));

    const read = result.completedSteps[0];
    expect(read.resultTruncated).toBe(true);
    expect(String(read.result)).toMatch(/Re-read it on its own with extract_text/);
    expect(JSON.stringify(result, null, 2).length).toBeLessThanOrEqual(32_000);
  });

  it('drops the oldest step results first when the whole envelope is too big', async () => {
    // Each read is inside the per-step cap, but ten of them are not inside the
    // envelope budget. The end of the run is what the caller needs, so the
    // front is what goes.
    const chunk = 'y'.repeat(MAX_BATCH_STEP_RESULT_CHARS - 100);
    const h = harness({ resultFor: () => chunk });
    const list = steps(...Array.from({ length: 12 }, () => 'read' as const));
    const result = await runBatch(h.deps, TAB, list);

    expect(JSON.stringify(result, null, 2).length).toBeLessThanOrEqual(32_000);
    expect(result.truncated).toBe(true);
    expect(result.completedSteps[0].result).toBeUndefined();
    expect(result.completedSteps[0].resultTruncated).toBe(true);
    expect(result.completedSteps.at(-1)!.result).toBe(chunk);
    // Nothing was hidden: every step is still listed with its outcome.
    expect(result.completedSteps).toHaveLength(12);
  });
});

describe('parseBatchSteps', () => {
  it('refuses a scripting step however it is spelled', () => {
    for (const action of ['execute_js', 'query_js', 'script', 'eval']) {
      expect(() => parseBatchSteps([{ action }])).toThrow(/may not run page scripts/);
    }
  });

  it('refuses a navigate step', () => {
    expect(() => parseBatchSteps([{ action: 'navigate', url: 'https://x.example' }]))
      .toThrow(/may not navigate/);
  });

  it('accepts a decoded array as well as the JSON string the schema asks for', () => {
    const decoded = parseBatchSteps([{ action: 'click', locator: { css: '#a' } }]);
    const fromString = parseBatchSteps('[{"action":"click","locator":{"css":"#a"}}]');
    expect(decoded).toEqual(fromString);
  });

  it('keeps only the fields the step type uses', () => {
    const [step] = parseBatchSteps([
      { action: 'click', locator: { css: '#a' }, code: 'alert(1)', value: 'x' },
    ]);
    expect(step).toEqual({ action: 'click', locator: { css: '#a' } });
  });
});

describe('batchOrigin', () => {
  it('collapses the spellings that mean the same site', () => {
    expect(batchOrigin('https://Example.COM./a?b=1')).toBe('https://example.com');
    expect(batchOrigin('https://user:pw@example.com:443/x')).toBe('https://example.com');
    expect(batchOrigin('http://example.com:8080/x')).toBe('http://example.com:8080');
  });

  it('has no origin for a page that could never earn a grant', () => {
    for (const url of ['about:blank', 'file:///tmp/x.html', 'data:text/html,<b>x', 'nonsense', '']) {
      expect(batchOrigin(url)).toBeNull();
    }
  });
});
