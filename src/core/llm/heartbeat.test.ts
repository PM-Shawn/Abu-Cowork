import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHeartbeat, anySignal } from './heartbeat';

describe('heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls onTimeout after specified delay', () => {
    const onTimeout = vi.fn();
    const hb = createHeartbeat(5000, onTimeout);
    hb.reset();

    vi.advanceTimersByTime(4999);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it('resets timer on each reset() call', () => {
    const onTimeout = vi.fn();
    const hb = createHeartbeat(5000, onTimeout);
    hb.reset();

    vi.advanceTimersByTime(3000);
    hb.reset(); // Reset at 3s — should now wait another 5s

    vi.advanceTimersByTime(4999);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it('does not call onTimeout after clear()', () => {
    const onTimeout = vi.fn();
    const hb = createHeartbeat(5000, onTimeout);
    hb.reset();

    vi.advanceTimersByTime(3000);
    hb.clear();

    vi.advanceTimersByTime(10000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('can be reset multiple times', () => {
    const onTimeout = vi.fn();
    const hb = createHeartbeat(1000, onTimeout);

    for (let i = 0; i < 10; i++) {
      hb.reset();
      vi.advanceTimersByTime(500);
    }
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it('clear() is safe to call multiple times', () => {
    const onTimeout = vi.fn();
    const hb = createHeartbeat(1000, onTimeout);
    hb.reset();
    hb.clear();
    hb.clear(); // Should not throw
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('clear() before reset() is safe', () => {
    const onTimeout = vi.fn();
    const hb = createHeartbeat(1000, onTimeout);
    hb.clear(); // No timer started yet — should not throw
    expect(onTimeout).not.toHaveBeenCalled();
  });
});

describe('anySignal', () => {
  // Verifies the OR-merge contract: result aborts when ANY input aborts, and
  // starts aborted if any input is already aborted. Run against both the native
  // AbortSignal.any and the manual fallback so old-WKWebView behavior matches.
  function runBehaviorChecks() {
    // A later abort on any input propagates to the merged signal.
    const a = new AbortController();
    const b = new AbortController();
    const merged = anySignal([a.signal, b.signal]);
    expect(merged.aborted).toBe(false);
    b.abort();
    expect(merged.aborted).toBe(true);

    // An already-aborted input makes the merged signal start aborted.
    const c = new AbortController();
    c.abort();
    const d = new AbortController();
    expect(anySignal([c.signal, d.signal]).aborted).toBe(true);
  }

  it('works with native AbortSignal.any', () => {
    expect(typeof AbortSignal.any).toBe('function'); // sanity: native present in test env
    runBehaviorChecks();
  });

  it('works via fallback when AbortSignal.any is unavailable (old WKWebView)', () => {
    const original = AbortSignal.any;
    try {
      (AbortSignal as unknown as { any: unknown }).any = undefined;
      runBehaviorChecks();
    } finally {
      (AbortSignal as unknown as { any: typeof original }).any = original;
    }
  });
});
