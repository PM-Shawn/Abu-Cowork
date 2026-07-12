import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { readDir, watch, exists, type DirEntry, type UnwatchFn } from '@tauri-apps/plugin-fs';
import { useWorkspaceTree } from './useWorkspaceTree';
import { useWorkspaceStore } from '@/stores/workspaceStore';

const mockReadDir = vi.mocked(readDir);

function dirEntry(name: string): DirEntry {
  return { name, isDirectory: true, isFile: false, isSymlink: false };
}

function fileEntry(name: string): DirEntry {
  return { name, isDirectory: false, isFile: true, isSymlink: false };
}

/** Canned filesystem: readDir(path) resolves to whatever is registered for that path. */
function stubFs(tree: Record<string, DirEntry[]>) {
  mockReadDir.mockImplementation(async (path: string | URL) => {
    const key = String(path);
    const entries = tree[key];
    if (!entries) throw new Error(`ENOENT: no such directory ${key}`);
    return entries;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReadDir.mockResolvedValue([]);
  useWorkspaceStore.setState({ currentPath: null, recentPaths: [] });
});

describe('useWorkspaceTree', () => {
  it('returns null root and no entries when no workspace is bound', () => {
    const { result } = renderHook(() => useWorkspaceTree());
    expect(result.current.rootPath).toBeNull();
    expect(result.current.rootEntries).toEqual([]);
    expect(result.current.isRootLoading).toBe(false);
  });

  it('loads the root directory listing when a workspace path is set', async () => {
    stubFs({
      '/proj': [dirEntry('src'), fileEntry('package.json')],
    });
    useWorkspaceStore.setState({ currentPath: '/proj' });

    const { result } = renderHook(() => useWorkspaceTree());

    await waitFor(() => expect(result.current.isRootLoading).toBe(false));
    expect(mockReadDir).toHaveBeenCalledWith('/proj');
    expect(result.current.rootEntries.map((e) => e.name)).toEqual(['src', 'package.json']);
    expect(result.current.rootEntries.find((e) => e.name === 'src')?.path).toBe('/proj/src');
  });

  it('re-reads the root listing when the workspace watch fires (auto-refresh / F3)', async () => {
    let watchCb: (() => void) | null = null;
    vi.mocked(exists).mockResolvedValue(true);
    vi.mocked(watch).mockImplementation(async (_paths, cb) => {
      watchCb = cb as () => void;
      return vi.fn() as unknown as UnwatchFn;
    });
    stubFs({ '/proj': [fileEntry('a.md')] });
    useWorkspaceStore.setState({ currentPath: '/proj' });

    const { result } = renderHook(() => useWorkspaceTree());
    await waitFor(() => expect(result.current.isRootLoading).toBe(false));
    await waitFor(() => expect(watchCb).not.toBeNull());
    const callsBefore = mockReadDir.mock.calls.length;

    // Agent creates a file → recursive watch fires → refresh() re-reads root.
    stubFs({ '/proj': [fileEntry('a.md'), fileEntry('b.md')] });
    await act(async () => { watchCb!(); await Promise.resolve(); });

    await waitFor(() => expect(mockReadDir.mock.calls.length).toBeGreaterThan(callsBefore));
    await waitFor(() =>
      expect(result.current.rootEntries.map((e) => e.name)).toEqual(['a.md', 'b.md']),
    );
  });

  it('folders sort before files, each group locale-aware by name', async () => {
    stubFs({
      '/proj': [
        fileEntry('zeta.ts'),
        dirEntry('Beta'),
        fileEntry('alpha.ts'),
        dirEntry('alpha-folder'),
      ],
    });
    useWorkspaceStore.setState({ currentPath: '/proj' });

    const { result } = renderHook(() => useWorkspaceTree());
    await waitFor(() => expect(result.current.rootEntries.length).toBe(4));

    const names = result.current.rootEntries.map((e) => e.name);
    // Directories (alpha-folder, Beta) before files (alpha.ts, zeta.ts); each
    // group alphabetical/locale-aware (case-insensitive) by name.
    expect(names).toEqual(['alpha-folder', 'Beta', 'alpha.ts', 'zeta.ts']);
  });

  it('filters out node_modules, .git, .DS_Store and dotfiles to stay lightweight', async () => {
    stubFs({
      '/proj': [
        dirEntry('node_modules'),
        dirEntry('.git'),
        fileEntry('.DS_Store'),
        fileEntry('.env'),
        dirEntry('src'),
        fileEntry('README.md'),
      ],
    });
    useWorkspaceStore.setState({ currentPath: '/proj' });

    const { result } = renderHook(() => useWorkspaceTree());
    await waitFor(() => expect(result.current.isRootLoading).toBe(false));

    const names = result.current.rootEntries.map((e) => e.name);
    expect(names).toEqual(['src', 'README.md']);
  });

  it('does not eagerly read subdirectory children before they are expanded', async () => {
    stubFs({
      '/proj': [dirEntry('src')],
      '/proj/src': [fileEntry('index.ts')],
    });
    useWorkspaceStore.setState({ currentPath: '/proj' });

    const { result } = renderHook(() => useWorkspaceTree());
    await waitFor(() => expect(result.current.rootEntries.length).toBe(1));

    expect(mockReadDir).toHaveBeenCalledTimes(1); // only the root, not 'src'
    expect(result.current.childrenByPath.has('/proj/src')).toBe(false);
  });

  it('lazily loads a directory children on expand, and caches them', async () => {
    stubFs({
      '/proj': [dirEntry('src')],
      '/proj/src': [fileEntry('index.ts'), dirEntry('utils')],
    });
    useWorkspaceStore.setState({ currentPath: '/proj' });

    const { result } = renderHook(() => useWorkspaceTree());
    await waitFor(() => expect(result.current.rootEntries.length).toBe(1));

    act(() => result.current.toggleExpand('/proj/src'));

    await waitFor(() => expect(result.current.childrenByPath.has('/proj/src')).toBe(true));
    expect(result.current.expandedPaths.has('/proj/src')).toBe(true);
    const children = result.current.childrenByPath.get('/proj/src') ?? [];
    expect(children.map((c) => c.name)).toEqual(['utils', 'index.ts']);
    expect(mockReadDir).toHaveBeenCalledWith('/proj/src');

    // Collapse then re-expand — should not re-fetch since it's already cached.
    act(() => result.current.toggleExpand('/proj/src'));
    expect(result.current.expandedPaths.has('/proj/src')).toBe(false);
    mockReadDir.mockClear();
    act(() => result.current.toggleExpand('/proj/src'));
    expect(result.current.expandedPaths.has('/proj/src')).toBe(true);
    expect(mockReadDir).not.toHaveBeenCalled();
  });

  it('surfaces an error when the root directory fails to read', async () => {
    mockReadDir.mockRejectedValue(new Error('permission denied'));
    useWorkspaceStore.setState({ currentPath: '/no-access' });

    const { result } = renderHook(() => useWorkspaceTree());

    await waitFor(() => expect(result.current.rootError).not.toBeNull());
    expect(result.current.rootEntries).toEqual([]);
    expect(result.current.isRootLoading).toBe(false);
  });

  it('surfaces a per-directory error without breaking the rest of the tree', async () => {
    stubFs({
      '/proj': [dirEntry('broken')],
    });
    // '/proj/broken' intentionally not registered → readDir throws for it.
    useWorkspaceStore.setState({ currentPath: '/proj' });

    const { result } = renderHook(() => useWorkspaceTree());
    await waitFor(() => expect(result.current.rootEntries.length).toBe(1));

    act(() => result.current.toggleExpand('/proj/broken'));

    await waitFor(() => expect(result.current.errorsByPath.has('/proj/broken')).toBe(true));
    expect(result.current.childrenByPath.has('/proj/broken')).toBe(false);
    expect(result.current.loadingPaths.has('/proj/broken')).toBe(false);
  });

  it('resets the tree and reloads when the workspace path changes', async () => {
    stubFs({
      '/proj-a': [dirEntry('src')],
      '/proj-b': [fileEntry('main.py')],
    });
    useWorkspaceStore.setState({ currentPath: '/proj-a' });

    const { result, rerender } = renderHook(() => useWorkspaceTree());
    await waitFor(() => expect(result.current.rootEntries.map((e) => e.name)).toEqual(['src']));

    act(() => result.current.toggleExpand('/proj-a/src'));
    await waitFor(() => expect(result.current.expandedPaths.has('/proj-a/src')).toBe(true));

    useWorkspaceStore.setState({ currentPath: '/proj-b' });
    rerender();

    await waitFor(() => expect(result.current.rootEntries.map((e) => e.name)).toEqual(['main.py']));
    expect(result.current.expandedPaths.size).toBe(0);
    expect(result.current.childrenByPath.size).toBe(0);
  });
});
