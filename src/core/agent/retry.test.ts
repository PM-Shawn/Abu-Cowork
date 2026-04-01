import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetry } from './retry';
import { LLMError } from '../llm/adapter';

describe('retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns immediately on success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable LLMError', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new LLMError('rate limit', 'rate_limit', { retryable: true }))
      .mockResolvedValueOnce('ok');

    const promise = withRetry(fn, { baseDelayMs: 100 });
    // Advance past the delay
    await vi.advanceTimersByTimeAsync(200);
    const result = await promise;

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-retryable errors', async () => {
    const err = new LLMError('auth failed', 'authentication', { retryable: false });
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withRetry(fn)).rejects.toThrow('auth failed');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-LLMError', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('generic error'));

    await expect(withRetry(fn)).rejects.toThrow('generic error');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws after max retries exhausted', async () => {
    vi.useRealTimers(); // Use real timers for this test to avoid unhandled rejection
    const err = new LLMError('overloaded', 'overloaded', { retryable: true });
    const fn = vi.fn().mockRejectedValue(err);

    await expect(
      withRetry(fn, { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 50 })
    ).rejects.toThrow('overloaded');
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    vi.useFakeTimers(); // Restore for other tests
  });

  it('calls onRetry callback on each retry', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new LLMError('rate limit', 'rate_limit', { retryable: true }))
      .mockResolvedValueOnce('ok');

    const onRetry = vi.fn();
    const promise = withRetry(fn, { baseDelayMs: 100 }, undefined, onRetry);
    await vi.advanceTimersByTimeAsync(200);
    await promise;

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(LLMError), expect.any(Number));
  });

  it('respects retryAfterMs from error', async () => {
    vi.useRealTimers(); // Use real timers — fake timers cause flaky behavior with jitter
    const fn = vi.fn()
      .mockRejectedValueOnce(new LLMError('rate limit', 'rate_limit', { retryable: true, retryAfterMs: 50 }))
      .mockResolvedValueOnce('ok');

    const onRetry = vi.fn();
    await withRetry(fn, { baseDelayMs: 10 }, undefined, onRetry);

    // The delay should be based on retryAfterMs (50) with small jitter (±10%)
    const actualDelay = onRetry.mock.calls[0][2] as number;
    expect(actualDelay).toBeGreaterThanOrEqual(45);
    expect(actualDelay).toBeLessThanOrEqual(60);
    vi.useFakeTimers(); // Restore
  });

  it('cancels on abort signal (before retry)', async () => {
    const controller = new AbortController();
    controller.abort();

    const fn = vi.fn().mockResolvedValue('ok');

    await expect(
      withRetry(fn, {}, controller.signal)
    ).rejects.toThrow('Request cancelled');
    expect(fn).not.toHaveBeenCalled();
  });

  it('does not retry cancelled errors', async () => {
    const fn = vi.fn().mockRejectedValue(
      new LLMError('cancelled', 'cancelled', { retryable: false })
    );

    await expect(withRetry(fn)).rejects.toThrow('cancelled');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
