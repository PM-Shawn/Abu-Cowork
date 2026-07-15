import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openPath } from '@tauri-apps/plugin-opener';
import { openWithDefaultApp } from './openWithDefaultApp';

vi.mock('@tauri-apps/plugin-opener', () => ({ openPath: vi.fn() }));

describe('openWithDefaultApp', () => {
  beforeEach(() => vi.clearAllMocks());
  it('calls openPath with the file path', async () => {
    (openPath as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    await openWithDefaultApp('/Users/x/a.pdf');
    expect(openPath).toHaveBeenCalledWith('/Users/x/a.pdf');
  });
  it('rethrows on failure', async () => {
    (openPath as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('denied'));
    await expect(openWithDefaultApp('/etc/x')).rejects.toThrow('denied');
  });
});
