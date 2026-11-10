import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { homeDir, tempDir } from '@tauri-apps/api/path';
import { lstat, readFile, stat } from '@tauri-apps/plugin-fs';
import { canonicalizeElectronPathForPolicy } from '../../utils/electronHost';
import { setPlatformForTest } from '../../test/helpers';
import { authorizeWorkspace, checkListPath, checkReadPath, checkWritePath, revokeWorkspace } from './pathSafety';

vi.mock('../../utils/electronHost', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/electronHost')>()),
  canonicalizeElectronPathForPolicy: vi.fn().mockResolvedValue(null),
}));

const HOME = 'C:\\Users\\testuser';

describe('pathSafety · credential locations on Windows', () => {
  let restorePlatform: () => void;

  beforeAll(() => {
    restorePlatform = setPlatformForTest('windows');
    // The home directory is cached on first use, so it is pinned before any check runs.
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
    vi.mocked(stat).mockReset();
    vi.mocked(stat).mockResolvedValue({ size: 0, isDirectory: false } as never);
    vi.mocked(readFile).mockReset();
    vi.mocked(readFile).mockResolvedValue(new Uint8Array());
    authorizeWorkspace(HOME, ['read', 'write']);
  });
  afterEach(() => revokeWorkspace(HOME));

  it.each([
    `${HOME}\\AppData\\Local\\Google\\Chrome\\User Data\\Profile 1\\Network\\Cookies`,
    `${HOME}\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Login Data`,
    `${HOME}\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\x\\key4.db`,
    `${HOME}\\AppData\\Local\\Tencent\\QQBrowser\\User Data\\Default\\Cookies`,
    `${HOME}\\AppData\\Roaming\\Microsoft\\Crypto\\RSA\\key`,
    `${HOME}\\AppData\\Roaming\\Bitwarden\\data.json`,
    `${HOME}\\.ssh\\id_rsa`,
    `${HOME}\\Documents\\keys\\server.ppk`,
  ])('refuses %s', async (path) => {
    const result = await checkReadPath(path);
    expect(result.allowed).toBe(false);
    expect(result.denialKind).toBe('blocked');
  });

  it('sees through the spellings Win32 ignores: case, trailing dot or space, stream suffix', async () => {
    for (const path of [
      `${HOME}\\.SSH\\ID_RSA`,
      `${HOME}\\.ssh\\id_rsa.`,
      `${HOME}\\.ssh\\id_rsa `,
      `${HOME}\\.ssh\\id_rsa::$DATA`,
      `${HOME}\\Documents\\vault.kdbx::$DATA`,
    ]) {
      expect((await checkReadPath(path)).denialKind, path).toBe('blocked');
    }
  });

  it('refuses a short 8.3 name nobody can expand', async () => {
    const result = await checkReadPath('C:\\Users\\TESTUS~1\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cookies');
    expect(result.allowed).toBe(false);
    expect(result.denialKind).toBe('blocked');
  });

  it('closes the app\'s own data folders in Roaming and Local', async () => {
    for (const path of [`${HOME}\\AppData\\Roaming\\Abu\\secrets.json`, `${HOME}\\AppData\\Local\\Abu\\Cookies`]) {
      expect((await checkReadPath(path)).denialKind, path).toBe('blocked');
    }
    expect((await checkListPath(`${HOME}\\AppData\\Roaming\\Abu`)).denialKind).toBe('blocked');
  });

  it('refuses writes to the Startup folder and to a PowerShell profile on a redirected Documents', async () => {
    const startup = await checkWritePath(`${HOME}\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.lnk`);
    expect(startup.denialKind).toBe('blocked');
    const profile = await checkWritePath('D:\\OneDrive\\Documents\\WindowsPowerShell\\profile.ps1');
    expect(profile.denialKind).toBe('blocked');
  });

  it('keeps ordinary files readable', async () => {
    expect((await checkReadPath(`${HOME}\\Documents\\report.docx`)).allowed).toBe(true);
  });
});
