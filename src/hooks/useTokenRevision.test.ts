// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTokenRevision } from './useTokenRevision';

const ROOT_ATTRIBUTES = ['data-contrast', 'data-transparency', 'data-window-material', 'data-motion'];

// happy-dom delivers MutationObserver records on a timer; one awaited turn of the
// fake clock inside act() delivers them and flushes the state update.
async function change(mutate: () => void): Promise<void> {
  await act(async () => {
    mutate();
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.documentElement.classList.remove('dark');
  for (const name of ROOT_ATTRIBUTES) document.documentElement.removeAttribute(name);
});

describe('useTokenRevision', () => {
  it('starts at 0', () => {
    const { result } = renderHook(() => useTokenRevision());
    expect(result.current).toBe(0);
  });

  it('counts the dark class and increased contrast', async () => {
    const { result } = renderHook(() => useTokenRevision());

    await change(() => document.documentElement.classList.add('dark'));
    expect(result.current).toBe(1);

    await change(() => document.documentElement.setAttribute('data-contrast', 'more'));
    expect(result.current).toBe(2);

    await change(() => document.documentElement.removeAttribute('data-contrast'));
    expect(result.current).toBe(3);

    await change(() => document.documentElement.classList.remove('dark'));
    expect(result.current).toBe(4);
  });

  it('counts reduced transparency and the window material', async () => {
    const { result } = renderHook(() => useTokenRevision());

    await change(() => document.documentElement.setAttribute('data-transparency', 'reduced'));
    expect(result.current).toBe(1);

    await change(() => document.documentElement.setAttribute('data-window-material', 'none'));
    expect(result.current).toBe(2);
  });

  it('counts one change once', async () => {
    const { result } = renderHook(() => useTokenRevision());

    await change(() => document.documentElement.setAttribute('data-contrast', 'more'));
    await change(() => {});

    expect(result.current).toBe(1);
  });

  it('ignores attributes that do not change a color', async () => {
    const { result } = renderHook(() => useTokenRevision());

    await change(() => document.documentElement.setAttribute('data-motion', 'reduced'));
    await change(() => document.documentElement.setAttribute('lang', 'en'));

    expect(result.current).toBe(0);
  });

  it('stops watching when the component unmounts', () => {
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    const { unmount } = renderHook(() => useTokenRevision());
    expect(disconnect).not.toHaveBeenCalled();

    unmount();

    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
