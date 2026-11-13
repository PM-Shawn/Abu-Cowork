import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { homeDir, tempDir } from '@tauri-apps/api/path';
import { lstat } from '@tauri-apps/plugin-fs';
import { canonicalizeElectronPathForPolicy } from '../../utils/electronHost';
import { setPlatformForTest } from '../../test/helpers';
import { checkWritePath } from './pathSafety';

vi.mock('../../utils/electronHost', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/electronHost')>()),
  canonicalizeElectronPathForPolicy: vi.fn().mockResolvedValue(null),
}));

const HOME = 'C:\\Users\\testuser';

describe('pathSafety · what a write grant covers on Windows', () => {
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
  beforeEach(() => {
    vi.mocked(canonicalizeElectronPathForPolicy).mockReset();
    vi.mocked(canonicalizeElectronPathForPolicy).mockResolvedValue(null);
    vi.mocked(lstat).mockReset();
    vi.mocked(lstat).mockResolvedValue({ isSymlink: false } as never);
  });

  it('asks for the folder holding the file on another drive', async () => {
    const result = await checkWritePath('D:\\工作\\报表\\q3.xlsx');
    expect(result).toMatchObject({ needsPermission: true, permissionPath: 'd:/工作/报表', permissionIsFolder: true });
  });

  it('keeps the file as the unit for a file at the root of a drive', async () => {
    const result = await checkWritePath('D:\\q3.xlsx');
    expect(result.needsPermission).toBe(true);
    expect(result.permissionIsFolder).toBeUndefined();
  });

  it('does not offer the user folder, or the Users folder above it', async () => {
    for (const path of [HOME, 'C:\\Users']) {
      const result = await checkWritePath(path);
      expect(result.allowed, path).toBe(false);
      expect(result.needsPermission, path).toBeUndefined();
    }
  });

  it('keeps a write to AppData per file', async () => {
    const result = await checkWritePath(`${HOME}\\AppData\\Roaming\\SomeApp\\a.json`);
    expect(result.permissionIsFolder).toBeUndefined();
  });

  it('keeps a write to the shared program data per file', async () => {
    const result = await checkWritePath('C:\\ProgramData\\Tool\\a.json');
    expect(result.needsPermission).toBe(true);
    expect(result.permissionIsFolder).toBeUndefined();
  });

  it.each(['D:\\Windows\\System32\\a.dll', 'E:\\Program Files\\Tool\\a.dll', 'D:\\Program Files (x86)\\Tool\\a.dll'])(
    'refuses a write under the system or program folder of any drive: %s',
    async (target) => {
      const result = await checkWritePath(target);
      expect(result.allowed).toBe(false);
      expect(result.needsPermission).toBeUndefined();
    },
  );
});
