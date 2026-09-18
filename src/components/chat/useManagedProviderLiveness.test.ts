// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OFFLINE_RECHECK_MS, useManagedProviderLiveness } from './useManagedProviderLiveness';

const mockRefresh = vi.fn().mockResolvedValue(undefined);

vi.mock('@/core/llm/managedProviderRefresh', () => ({
  refreshManagedProvider: (...args: unknown[]) => mockRefresh(...args),
}));

const managed = { id: 'org-models', source: 'managed' as const, status: 'verified' as const };
const personal = { id: 'deepseek', source: 'builtin' as const, status: 'verified' as const };

describe('useManagedProviderLiveness', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRefresh.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it('pulls the list when the composer settles on a managed provider and again when a turn ends', () => {
    const { rerender } = renderHook(
      ({ provider, running }) => useManagedProviderLiveness(provider, running),
      { initialProps: { provider: managed, running: false } },
    );
    expect(mockRefresh).toHaveBeenCalledTimes(1);

    rerender({ provider: managed, running: true });
    expect(mockRefresh).toHaveBeenCalledTimes(1);

    rerender({ provider: managed, running: false });
    expect(mockRefresh).toHaveBeenCalledTimes(2);
    expect(mockRefresh).toHaveBeenLastCalledWith('org-models');
  });

  it('leaves the user\'s own providers alone', () => {
    const { rerender } = renderHook(
      ({ provider, running }) => useManagedProviderLiveness(provider, running),
      { initialProps: { provider: personal, running: false } },
    );
    rerender({ provider: personal, running: true });
    rerender({ provider: personal, running: false });
    rerender({ provider: undefined, running: false });
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('keeps re-checking while the last pull failed, and stops once it succeeds', async () => {
    const { rerender, unmount } = renderHook(
      ({ provider }) => useManagedProviderLiveness(provider, false),
      { initialProps: { provider: { ...managed, status: 'failed' as const } } },
    );
    mockRefresh.mockClear();

    await vi.advanceTimersByTimeAsync(OFFLINE_RECHECK_MS * 2);
    expect(mockRefresh).toHaveBeenCalledTimes(2);

    rerender({ provider: managed });
    mockRefresh.mockClear();
    await vi.advanceTimersByTimeAsync(OFFLINE_RECHECK_MS * 2);
    expect(mockRefresh).not.toHaveBeenCalled();

    rerender({ provider: { ...managed, status: 'failed' as const } });
    unmount();
    await vi.advanceTimersByTimeAsync(OFFLINE_RECHECK_MS * 2);
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
