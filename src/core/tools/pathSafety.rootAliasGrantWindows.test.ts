import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { homeDir, tempDir } from '@tauri-apps/api/path';
import { lstat } from '@tauri-apps/plugin-fs';
import { canonicalizeElectronPathForPolicy } from '../../utils/electronHost';
import { setPlatformForTest } from '../../test/helpers';
import {
  authorizeWorkspace,
  checkReadPath,
  checkWritePath,
  getAuthorizedDirs,
  revokeWorkspace,
} from './pathSafety';

vi.mock('../../utils/electronHost', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/electronHost')>()),
  canonicalizeElectronPathForPolicy: vi.fn().mockResolvedValue(null),
}));

const GRANTS_USED = [
  'C:\\.',
  'C:\\',
  'C:',
  'C:\\Users\\..',
  'C:\\Users\\testuser\\..',
  '\\\\server\\share',
  '\\.',
  'C:\\Users\\testuser\\Projects\\app',
  'C:\\Users\\testuser\\.\\Projects\\\\app\\',
];

describe('pathSafety · root-alias grants on Windows', () => {
  let restorePlatform: () => void;

  beforeAll(() => {
    restorePlatform = setPlatformForTest('windows');
    // The home directory is cached on first use, so it is pinned before any check runs.
    vi.mocked(homeDir).mockResolvedValue('C:\\Users\\testuser');
    vi.mocked(tempDir).mockResolvedValue('C:\\Users\\testuser\\AppData\\Local\\Temp');
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
    for (const p of GRANTS_USED) revokeWorkspace(p);
  });

  afterEach(() => {
    for (const p of GRANTS_USED) revokeWorkspace(p);
  });

  it('a drive root grant in any spelling is dropped', async () => {
    authorizeWorkspace('C:\\.');
    authorizeWorkspace('C:\\');
    authorizeWorkspace('C:');
    expect(getAuthorizedDirs()).toEqual([]);
    const read = await checkReadPath('C:\\Users\\testuser\\Documents\\a.txt');
    expect(read.allowed).toBe(false);
    expect(read.needsPermission).toBe(true);
    expect((await checkReadPath('C:\\Windows\\win.ini')).allowed).toBe(false);
  });

  it('a "C:\\<top-level dir>\\.." grant is dropped', async () => {
    authorizeWorkspace('C:\\Users\\..');
    expect(getAuthorizedDirs()).toEqual([]);
    expect((await checkReadPath('C:\\Users\\testuser\\Documents\\a.txt')).allowed).toBe(false);
    expect((await checkWritePath('C:\\Users\\otheruser\\notes.txt')).allowed).toBe(false);
  });

  it('a "C:\\<dir>\\.." grant does not grant the parent folder', async () => {
    authorizeWorkspace('C:\\Users\\testuser\\..');
    expect(getAuthorizedDirs()).toEqual([]);
    expect((await checkReadPath('C:\\Users\\testuser\\Pictures\\holiday.png')).allowed).toBe(false);
    expect((await checkReadPath('C:\\Users\\otheruser\\Documents\\report.docx')).allowed).toBe(false);
    expect((await checkReadPath('C:\\Windows\\win.ini')).allowed).toBe(false);
  });

  it('a UNC grant keeps its prefix and UNC requests stay rejected', async () => {
    authorizeWorkspace('\\\\server\\share');
    expect(getAuthorizedDirs()).toEqual(['//server/share']);
    const read = await checkReadPath('\\\\server\\share\\a.txt');
    expect(read.allowed).toBe(false);
    expect(read.reason).toBe('UNC network paths are not supported');
    expect((await checkReadPath('C:\\server\\share\\a.txt')).allowed).toBe(false);
  });

  it('a drive-less "\\." grant is dropped', async () => {
    authorizeWorkspace('\\.');
    expect(getAuthorizedDirs()).toEqual([]);
    const read = await checkReadPath('\\Users\\testuser\\Documents\\a.txt');
    expect(read.allowed).toBe(false);
    expect(read.needsPermission).toBe(true);
    expect((await checkReadPath('C:\\Users\\testuser\\Documents\\a.txt')).allowed).toBe(false);
  });

  it('two spellings of one folder share one table entry and keep their case', async () => {
    authorizeWorkspace('C:\\Users\\testuser\\.\\Projects\\\\app\\');
    authorizeWorkspace('C:\\Users\\testuser\\Projects\\app');
    expect(getAuthorizedDirs()).toEqual(['C:/Users/testuser/Projects/app']);
    expect(await checkReadPath('C:\\Users\\testuser\\Projects\\app\\index.ts')).toMatchObject({ allowed: true });
    revokeWorkspace('C:\\Users\\testuser\\.\\Projects\\\\app\\');
    expect(getAuthorizedDirs()).toEqual([]);
    expect((await checkReadPath('C:\\Users\\testuser\\Projects\\app\\index.ts')).allowed).toBe(false);
  });
});
