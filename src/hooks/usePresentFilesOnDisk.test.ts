// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PresentedFile } from '@/utils/presentedFiles';

const exists = vi.fn<(path: string) => Promise<boolean>>();
vi.mock('@/core/tools/fsBridge', () => ({
  exists: (path: string) => exists(path),
}));

import { usePresentFilesOnDisk } from './usePresentFilesOnDisk';

const FILES: PresentedFile[] = [
  { path: '/ws/a.md', description: 'First' },
  { path: '/ws/b.md' },
  { path: '/ws/c.md', description: 'Third' },
];

describe('usePresentFilesOnDisk', () => {
  let onDisk: Set<string>;

  beforeEach(() => {
    onDisk = new Set(['/ws/a.md', '/ws/c.md']);
    exists.mockReset();
    exists.mockImplementation(async (path) => onDisk.has(path));
  });

  it('returns null until the check answers, then the files on disk in their order', async () => {
    const { result } = renderHook(() => usePresentFilesOnDisk(FILES, true));

    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current).toEqual([
      { path: '/ws/a.md', description: 'First' },
      { path: '/ws/c.md', description: 'Third' },
    ]);
  });

  it('returns an empty list and checks nothing while disabled', async () => {
    const { result } = renderHook(() => usePresentFilesOnDisk(FILES, false));

    expect(result.current).toEqual([]);
    await act(async () => {});
    expect(exists).not.toHaveBeenCalled();
  });

  it('keeps the same result across renders with an equal list', async () => {
    const { result, rerender } = renderHook(() => usePresentFilesOnDisk(FILES.map((file) => ({ ...file })), true));

    await waitFor(() => expect(result.current).not.toBeNull());
    const first = result.current;
    const calls = exists.mock.calls.length;
    rerender();
    expect(result.current).toBe(first);
    expect(exists.mock.calls.length).toBe(calls);
  });

  it('checks again when the window regains focus', async () => {
    const { result } = renderHook(() => usePresentFilesOnDisk(FILES, true));
    await waitFor(() => expect(result.current).toHaveLength(2));

    onDisk.add('/ws/b.md');
    act(() => { window.dispatchEvent(new Event('focus')); });

    await waitFor(() => expect(result.current).toHaveLength(3));
    expect(result.current?.map((file) => file.path)).toEqual(['/ws/a.md', '/ws/b.md', '/ws/c.md']);
  });

  it('drops a file that left the disk on the next focus check', async () => {
    const { result } = renderHook(() => usePresentFilesOnDisk(FILES, true));
    await waitFor(() => expect(result.current).toHaveLength(2));

    onDisk.delete('/ws/a.md');
    act(() => { window.dispatchEvent(new Event('focus')); });

    await waitFor(() => expect(result.current).toEqual([{ path: '/ws/c.md', description: 'Third' }]));
  });

  it('answers null for a new list until its own check returns', async () => {
    const { result, rerender } = renderHook(
      ({ files }: { files: PresentedFile[] }) => usePresentFilesOnDisk(files, true),
      { initialProps: { files: FILES } },
    );
    await waitFor(() => expect(result.current).toHaveLength(2));

    rerender({ files: [{ path: '/ws/c.md' }] });
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toEqual([{ path: '/ws/c.md' }]));
  });

  it('discards a result that arrives after the list changed', async () => {
    const pending: ((present: boolean) => void)[] = [];
    exists.mockImplementation((path) => (path === '/ws/slow.md'
      ? new Promise<boolean>((resolve) => { pending.push(resolve); })
      : Promise.resolve(true)));
    const { result, rerender } = renderHook(
      ({ files }: { files: PresentedFile[] }) => usePresentFilesOnDisk(files, true),
      { initialProps: { files: [{ path: '/ws/slow.md' }] } },
    );
    await waitFor(() => expect(pending).toHaveLength(1));

    rerender({ files: [{ path: '/ws/fast.md' }] });
    await waitFor(() => expect(result.current).toEqual([{ path: '/ws/fast.md' }]));
    await act(async () => { pending[0](true); });

    expect(result.current).toEqual([{ path: '/ws/fast.md' }]);
  });

  it('stops checking on focus after unmount', async () => {
    const { result, unmount } = renderHook(() => usePresentFilesOnDisk(FILES, true));
    await waitFor(() => expect(result.current).not.toBeNull());
    const calls = exists.mock.calls.length;

    unmount();
    window.dispatchEvent(new Event('focus'));

    expect(exists.mock.calls.length).toBe(calls);
  });
});
