import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { watch, exists, type WatchEvent, type UnwatchFn } from '@tauri-apps/plugin-fs';
import { usePreviewFileWatch } from './usePreviewFileWatch';
import { usePreviewStore } from '@/stores/previewStore';

const mockWatch = vi.mocked(watch);
const mockExists = vi.mocked(exists);

function makeEvent(paths: string[]): WatchEvent {
  return { type: 'any', paths, attrs: null };
}

/** Flush the microtasks the hook's async setup() awaits (exists() then watch()). */
async function flushSetup() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('usePreviewFileWatch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockExists.mockReset().mockResolvedValue(true);
    mockWatch.mockReset().mockResolvedValue(vi.fn());
    usePreviewStore.setState({ previewFilePath: null, chatWidth: null, reloadNonce: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not watch when filePath is null', async () => {
    renderHook(() => usePreviewFileWatch(null));
    await flushSetup();
    expect(mockWatch).not.toHaveBeenCalled();
  });

  it('does not watch when filePath is a data: URL', async () => {
    renderHook(() => usePreviewFileWatch('data:image/png;base64,abc'));
    await flushSetup();
    expect(mockExists).not.toHaveBeenCalled();
    expect(mockWatch).not.toHaveBeenCalled();
  });

  it('watches the parent directory of the file (not the file itself)', async () => {
    renderHook(() => usePreviewFileWatch('/proj/out/report.html'));
    await flushSetup();
    expect(mockExists).toHaveBeenCalledWith('/proj/out');
    expect(mockWatch).toHaveBeenCalledWith('/proj/out', expect.any(Function), { recursive: false });
  });

  it('skips watch() when the parent directory does not exist', async () => {
    mockExists.mockResolvedValue(false);
    renderHook(() => usePreviewFileWatch('/proj/out/report.html'));
    await flushSetup();
    expect(mockWatch).not.toHaveBeenCalled();
  });

  it('debounces a matching change event ~250ms before calling refreshPreview', async () => {
    let cb: (event: WatchEvent) => void = () => {};
    mockWatch.mockImplementation(async (_dir, callback) => {
      cb = callback;
      return vi.fn() as unknown as UnwatchFn;
    });

    renderHook(() => usePreviewFileWatch('/proj/out/report.html'));
    await flushSetup();

    act(() => {
      cb(makeEvent(['/proj/out/report.html']));
    });
    expect(usePreviewStore.getState().reloadNonce).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(usePreviewStore.getState().reloadNonce).toBe(1);
  });

  it('ignores change events for unrelated files in the same directory', async () => {
    let cb: (event: WatchEvent) => void = () => {};
    mockWatch.mockImplementation(async (_dir, callback) => {
      cb = callback;
      return vi.fn() as unknown as UnwatchFn;
    });

    renderHook(() => usePreviewFileWatch('/proj/out/report.html'));
    await flushSetup();

    act(() => {
      cb(makeEvent(['/proj/out/other-file.css']));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(usePreviewStore.getState().reloadNonce).toBe(0);
  });

  it('coalesces rapid successive matching events into a single refresh', async () => {
    let cb: (event: WatchEvent) => void = () => {};
    mockWatch.mockImplementation(async (_dir, callback) => {
      cb = callback;
      return vi.fn() as unknown as UnwatchFn;
    });

    renderHook(() => usePreviewFileWatch('/proj/out/report.html'));
    await flushSetup();

    act(() => {
      cb(makeEvent(['/proj/out/report.html']));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    act(() => {
      cb(makeEvent(['/proj/out/report.html']));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(usePreviewStore.getState().reloadNonce).toBe(1);
  });

  it('re-watches a new parent directory when filePath changes', async () => {
    const unwatchA = vi.fn();
    const unwatchB = vi.fn();
    mockWatch.mockResolvedValueOnce(unwatchA).mockResolvedValueOnce(unwatchB);

    const { rerender } = renderHook(({ path }) => usePreviewFileWatch(path), {
      initialProps: { path: '/proj/a/one.html' as string | null },
    });
    await flushSetup();
    expect(mockWatch).toHaveBeenNthCalledWith(1, '/proj/a', expect.any(Function), { recursive: false });
    expect(unwatchA).not.toHaveBeenCalled();

    rerender({ path: '/proj/b/two.html' });
    await flushSetup();

    expect(unwatchA).toHaveBeenCalledTimes(1);
    expect(mockWatch).toHaveBeenNthCalledWith(2, '/proj/b', expect.any(Function), { recursive: false });
  });

  it('unwatches and clears any pending debounce timer on unmount', async () => {
    const unwatchFn = vi.fn();
    let cb: (event: WatchEvent) => void = () => {};
    mockWatch.mockImplementation(async (_dir, callback) => {
      cb = callback;
      return unwatchFn;
    });

    const { unmount } = renderHook(() => usePreviewFileWatch('/proj/out/report.html'));
    await flushSetup();

    act(() => {
      cb(makeEvent(['/proj/out/report.html']));
    });

    unmount();
    expect(unwatchFn).toHaveBeenCalledTimes(1);

    // Pending debounce timer must not fire after unmount (would call
    // refreshPreview on a store the hook no longer "owns").
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(usePreviewStore.getState().reloadNonce).toBe(0);
  });
});
