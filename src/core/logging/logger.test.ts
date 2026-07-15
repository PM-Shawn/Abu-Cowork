import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeTextFile } from '@tauri-apps/plugin-fs';

/**
 * Regression: the disk-log path must be built with a separator between the
 * app-data dir and "logs". Tauri's appDataDir() returns NO trailing separator
 * (the global test mock returns "/Users/testuser/.abu"), so the old
 * `${base}logs` concat produced a SIBLING dir — "/Users/testuser/.abulogs" —
 * instead of "/Users/testuser/.abu/logs". Logs then silently landed outside
 * the app-data dir on both macOS and Windows. joinPath() inserts the separator.
 */
describe('logger disk persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes error logs under <appData>/logs/, not a sibling <appData>logs dir', async () => {
    const { createLogger } = await import('./logger');
    createLogger('test').error('boom', { detail: 1 });

    // Disk writes are debounced behind a 500ms setTimeout.
    await vi.advanceTimersByTimeAsync(600);

    const paths = (writeTextFile as unknown as { mock: { calls: unknown[][] } })
      .mock.calls.map((c) => c[0] as string);

    expect(paths.length).toBeGreaterThan(0);
    // Correct: separator between ".abu" and "logs".
    expect(paths.every((p) => p.startsWith('/Users/testuser/.abu/logs/'))).toBe(true);
    // Guard against the concat regression that dropped the separator.
    expect(paths.some((p) => p.includes('.abulogs'))).toBe(false);
  });
});
