import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openPath } from '@tauri-apps/plugin-opener';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/plugin-opener', () => ({ openPath: vi.fn() }));

let mockPlatform = 'macos';
vi.mock('@/utils/platform', () => ({
  getPlatform: () => mockPlatform,
}));

import { openWithDefaultApp } from './openWithDefaultApp';

describe('openWithDefaultApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPlatform = 'macos';
  });

  it('calls openPath with the file path', async () => {
    (openPath as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    await openWithDefaultApp('/Users/x/a.pdf');
    expect(openPath).toHaveBeenCalledWith('/Users/x/a.pdf');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('falls back to shell-open on macOS when openPath rejects (e.g. path outside the allowlist)', async () => {
    (openPath as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('path not allowed'));
    (invoke as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    await openWithDefaultApp('/opt/workspace/a.pdf');
    expect(invoke).toHaveBeenCalledWith('run_shell_command', expect.objectContaining({
      command: 'open "/opt/workspace/a.pdf"',
    }));
  });

  it('falls back to xdg-open on Linux when openPath rejects', async () => {
    mockPlatform = 'linux';
    (openPath as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('path not allowed'));
    (invoke as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    await openWithDefaultApp('/srv/data/a.pdf');
    expect(invoke).toHaveBeenCalledWith('run_shell_command', expect.objectContaining({
      command: 'xdg-open "/srv/data/a.pdf"',
    }));
  });

  it('falls back to start on Windows when openPath rejects', async () => {
    mockPlatform = 'windows';
    (openPath as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('path not allowed'));
    (invoke as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    await openWithDefaultApp('D:\\projects\\a.pdf');
    expect(invoke).toHaveBeenCalledWith('run_shell_command', expect.objectContaining({
      command: 'start "" "D:\\projects\\a.pdf"',
    }));
  });

  it('rethrows the original openPath error when the shell fallback also fails', async () => {
    (openPath as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('denied'));
    (invoke as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('shell also failed'));
    await expect(openWithDefaultApp('/etc/x')).rejects.toThrow('denied');
  });
});
