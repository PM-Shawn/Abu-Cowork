import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { homeDir, tempDir } from '@tauri-apps/api/path';
import { lstat } from '@tauri-apps/plugin-fs';
import { canonicalizeElectronPathForPolicy } from '../../utils/electronHost';
import { setPlatformForTest } from '../../test/helpers';
import { checkReadPath } from './pathSafety';

vi.mock('../../utils/electronHost', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/electronHost')>()),
  canonicalizeElectronPathForPolicy: vi.fn().mockResolvedValue(null),
}));

function resetHost() {
  vi.mocked(canonicalizeElectronPathForPolicy).mockReset();
  vi.mocked(canonicalizeElectronPathForPolicy).mockResolvedValue(null);
  vi.mocked(lstat).mockReset();
  vi.mocked(lstat).mockResolvedValue({ isSymlink: false } as never);
}

describe('pathSafety · the AppData folder is not one unit on Windows', () => {
  const HOME = 'C:\\Users\\testuser';
  let restorePlatform: () => void;
  beforeAll(() => {
    restorePlatform = setPlatformForTest('windows');
    vi.mocked(homeDir).mockResolvedValue(HOME);
    vi.mocked(tempDir).mockResolvedValue(`${HOME}\\AppData\\Local\\Temp`);
  });
  afterAll(() => {
    restorePlatform();
    vi.mocked(homeDir).mockResolvedValue('/Users/testuser');
    vi.mocked(tempDir).mockResolvedValue('/tmp');
  });
  beforeEach(resetHost);

  it('offers no folder grant for a file in AppData', async () => {
    const file = `${HOME}\\AppData\\Roaming\\SomeApp\\data.json`;
    const result = await checkReadPath(file);
    expect(result.allowed).toBe(false);
    // Before the fix `AppData` was offered (and, where permission is granted by itself, granted) as the unit.
    expect(result.permissionPath?.toLowerCase()).toBe('c:/users/testuser/appdata/roaming/someapp/data.json');
    expect(result.permissionIsFolder).toBeUndefined();
  });

  it('keeps offering the top-level folder for an ordinary one', async () => {
    const result = await checkReadPath(`${HOME}\\Documents\\a.txt`);
    expect(result.needsPermission).toBe(true);
    expect(result.permissionPath?.toLowerCase()).toBe('c:/users/testuser/documents');
  });
});
