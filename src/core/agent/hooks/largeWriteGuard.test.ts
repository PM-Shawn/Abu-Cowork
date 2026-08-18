import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local override of plugin-fs mock so `stat` is a vi.fn (the global setup
// only mocks `exists`). Other imports retain the global defaults.
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn().mockResolvedValue(false),
  stat: vi.fn().mockResolvedValue({ size: 0 }),
  readTextFile: vi.fn().mockResolvedValue(''),
  writeTextFile: vi.fn().mockResolvedValue(undefined),
  readDir: vi.fn().mockResolvedValue([]),
  mkdir: vi.fn().mockResolvedValue(undefined),
  remove: vi.fn().mockResolvedValue(undefined),
  watch: vi.fn().mockResolvedValue(() => {}),
  BaseDirectory: { AppData: 0, Home: 1 },
}));

import { exists, stat } from '@tauri-apps/plugin-fs';
import type { PreToolCallEvent } from '../lifecycleHooks';
import {
  LARGE_WRITE_THRESHOLD_BYTES,
  evaluateLargeWriteGuard,
} from './largeWriteGuard';

const existsMock = exists as unknown as ReturnType<typeof vi.fn>;
const statMock = stat as unknown as ReturnType<typeof vi.fn>;

function makeEvent(overrides: Partial<PreToolCallEvent>): PreToolCallEvent {
  return {
    type: 'preToolCall',
    timestamp: 1_700_000_000_000, // filler (TESTING.md §3) — not asserted on
    toolName: 'write_file',
    toolInput: { path: '/tmp/report.html', content: 'x' },
    ...overrides,
  };
}

describe('largeWriteGuard', () => {
  beforeEach(() => {
    existsMock.mockReset();
    statMock.mockReset();
  });

  it('allows write_file when target file does not exist (new file creation)', async () => {
    existsMock.mockResolvedValueOnce(false);
    const event = makeEvent({});
    await evaluateLargeWriteGuard(event);
    expect(event.blocked).toBeUndefined();
    expect(event.blockReason).toBeUndefined();
  });

  it('allows write_file when existing file is below threshold', async () => {
    existsMock.mockResolvedValueOnce(true);
    statMock.mockResolvedValueOnce({ size: 4 * 1024 });
    const event = makeEvent({});
    await evaluateLargeWriteGuard(event);
    expect(event.blocked).toBeUndefined();
  });

  it('blocks write_file when existing file exceeds threshold', async () => {
    existsMock.mockResolvedValueOnce(true);
    statMock.mockResolvedValueOnce({ size: 35488 });
    const event = makeEvent({});
    await evaluateLargeWriteGuard(event);
    expect(event.blocked).toBe(true);
    expect(event.blockReason).toMatch(/edit_file/);
    expect(event.blockReason).toMatch(/already exists/);
  });

  it('ignores tools other than write_file', async () => {
    existsMock.mockResolvedValueOnce(true);
    statMock.mockResolvedValueOnce({ size: 1024 * 1024 });
    const event = makeEvent({ toolName: 'edit_file' });
    await evaluateLargeWriteGuard(event);
    expect(event.blocked).toBeUndefined();
    expect(existsMock).not.toHaveBeenCalled();
  });

  it('reproduces msg[225]-style 35KB HTML overwrite: blocks with actionable hint', async () => {
    existsMock.mockResolvedValueOnce(true);
    statMock.mockResolvedValueOnce({ size: 35488 });
    const event = makeEvent({
      toolInput: {
        path: 'C:/Users/didi/AppData/Roaming/com.abu.app/conversations/mp0nwul0rcvitd/outputs/0504-0510 weekly.html',
        content: '<!DOCTYPE html>...35KB rewrite...',
      },
    });
    await evaluateLargeWriteGuard(event);
    expect(event.blocked).toBe(true);
    // Hint must mention the size (so agent understands magnitude) and a path forward.
    expect(event.blockReason).toContain('34.7KB');
    expect(event.blockReason).toMatch(/edit_file/);
    expect(event.blockReason).toMatch(/delete the file.*run_command/);
  });

  it('fails open when stat throws (sandbox / permission errors)', async () => {
    existsMock.mockResolvedValueOnce(true);
    statMock.mockRejectedValueOnce(new Error('permission denied'));
    const event = makeEvent({});
    await evaluateLargeWriteGuard(event);
    expect(event.blocked).toBeUndefined();
  });

  it('threshold constant is documented at 8KB', () => {
    expect(LARGE_WRITE_THRESHOLD_BYTES).toBe(8192);
  });
});
