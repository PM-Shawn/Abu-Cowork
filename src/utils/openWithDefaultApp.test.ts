import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openPath } from '@tauri-apps/plugin-opener';

vi.mock('@tauri-apps/plugin-opener', () => ({ openPath: vi.fn() }));

import { isRunByDefaultRefusal, openWithDefaultApp, OPEN_REFUSED_RUNS_BY_DEFAULT } from './openWithDefaultApp';

describe('openWithDefaultApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls openPath with the file path', async () => {
    (openPath as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    await openWithDefaultApp('/Users/x/a.pdf');
    expect(openPath).toHaveBeenCalledWith('/Users/x/a.pdf');
  });

  it('surfaces opener errors without constructing a shell command fallback', async () => {
    (openPath as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('denied'));
    await expect(openWithDefaultApp('/etc/x')).rejects.toThrow('denied');
  });
});

describe('isRunByDefaultRefusal', () => {
  it('recognizes the refusal as Electron IPC delivers it', () => {
    const delivered = new Error(`Error invoking remote method 'tauri:invoke': Error: ${OPEN_REFUSED_RUNS_BY_DEFAULT}`);
    expect(isRunByDefaultRefusal(delivered)).toBe(true);
    expect(isRunByDefaultRefusal(OPEN_REFUSED_RUNS_BY_DEFAULT)).toBe(true);
  });

  it('leaves every other failure alone', () => {
    expect(isRunByDefaultRefusal(new Error('No application is set to open the file'))).toBe(false);
    expect(isRunByDefaultRefusal(new Error("ENOENT: no such file or directory, realpath '/w/gone.pdf'"))).toBe(false);
    expect(isRunByDefaultRefusal(undefined)).toBe(false);
    expect(isRunByDefaultRefusal({ message: OPEN_REFUSED_RUNS_BY_DEFAULT })).toBe(false);
  });
});
