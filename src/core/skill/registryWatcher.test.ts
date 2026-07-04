import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { watch, exists, mkdir } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';

// Control the discovery store + the "recent refresh" signal.
const refreshMock = vi.fn().mockResolvedValue(undefined);
let lastRefreshAt = 0;
vi.mock('../../stores/discoveryStore', () => ({
  useDiscoveryStore: { getState: () => ({ refresh: refreshMock }) },
  getLastDiscoveryRefreshAt: () => lastRefreshAt,
}));

import { startRegistryWatcher, stopRegistryWatcher } from './registryWatcher';

const mockWatch = vi.mocked(watch);
const mockExists = vi.mocked(exists);
const mockMkdir = vi.mocked(mkdir);
const mockHomeDir = vi.mocked(homeDir);

type WatchCb = () => void;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  lastRefreshAt = 0; // far in the past → refreshes are NOT treated as echoes
  mockHomeDir.mockResolvedValue('/Users/test');
  mockExists.mockResolvedValue(true);
  mockMkdir.mockResolvedValue(undefined as never);
  mockWatch.mockResolvedValue((() => {}) as never);
});

afterEach(() => {
  stopRegistryWatcher();
  vi.useRealTimers();
});

describe('registryWatcher', () => {
  it('watches BOTH ~/.abu/skills and ~/.abu/agents recursively', async () => {
    await startRegistryWatcher();
    const paths = mockWatch.mock.calls.map((c) => String(c[0]));
    expect(paths.some((p) => p.endsWith('/.abu/skills'))).toBe(true);
    expect(paths.some((p) => p.endsWith('/.abu/agents'))).toBe(true);
    expect(mockWatch.mock.calls.every((c) => (c[2] as { recursive?: boolean })?.recursive)).toBe(true);
  });

  it('creates a registry dir if it does not exist yet', async () => {
    mockExists.mockResolvedValue(false);
    await startRegistryWatcher();
    expect(mockMkdir).toHaveBeenCalledWith(expect.stringContaining('/.abu/skills'), { recursive: true });
    expect(mockMkdir).toHaveBeenCalledWith(expect.stringContaining('/.abu/agents'), { recursive: true });
  });

  it('triggers a debounced discovery refresh when a registry dir changes', async () => {
    let cb: WatchCb = () => {};
    mockWatch.mockImplementation(async (_p, callback) => {
      cb = callback as WatchCb;
      return (() => {}) as never;
    });
    await startRegistryWatcher();

    cb(); cb(); cb(); // burst
    expect(refreshMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(900);
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('skips the refresh when a discovery refresh already ran within the echo window', async () => {
    let cb: WatchCb = () => {};
    mockWatch.mockImplementation(async (_p, callback) => {
      cb = callback as WatchCb;
      return (() => {}) as never;
    });
    await startRegistryWatcher();

    // Simulate an explicit install-time refresh that just happened.
    lastRefreshAt = Date.now();
    cb();
    await vi.advanceTimersByTimeAsync(900);
    expect(refreshMock).not.toHaveBeenCalled(); // treated as the install's own echo
  });

  it('is race-safe under StrictMode mount→cleanup→mount (no leaked watcher)', async () => {
    // Each start awaits before creating watchers; a stop mid-flight must invalidate it.
    const p1 = startRegistryWatcher(); // suspends at first await
    stopRegistryWatcher();             // synchronous: bumps generation, invalidates p1
    const p3 = startRegistryWatcher(); // the "real" mount
    await Promise.all([p1, p3]);

    // Only the final start actually created watchers (2 dirs) — the superseded
    // in-flight start created none, so nothing leaks.
    expect(mockWatch).toHaveBeenCalledTimes(2);
  });

  it('stops all watchers and cancels a pending refresh', async () => {
    const unwatchA = vi.fn();
    const unwatchB = vi.fn();
    let cb: WatchCb = () => {};
    const handles = [unwatchA, unwatchB];
    let i = 0;
    mockWatch.mockImplementation(async (_p, callback) => {
      cb = callback as WatchCb;
      return handles[i++] as never;
    });
    await startRegistryWatcher();
    cb(); // schedule a refresh
    stopRegistryWatcher();

    expect(unwatchA).toHaveBeenCalledTimes(1);
    expect(unwatchB).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(900);
    expect(refreshMock).not.toHaveBeenCalled(); // cancelled
  });

  it('does not throw if watch setup fails', async () => {
    mockWatch.mockRejectedValue(new Error('resource id is invalid'));
    await expect(startRegistryWatcher()).resolves.toBeUndefined();
  });
});
