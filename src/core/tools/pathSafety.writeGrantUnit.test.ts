import { describe, it, expect, beforeEach, vi } from 'vitest';
import { lstat } from '@tauri-apps/plugin-fs';
import { canonicalizeElectronPathForPolicy } from '../../utils/electronHost';
import { authorizeWorkspace, checkReadPath, checkWritePath, getAuthorizedWritablePaths, revokeWorkspace } from './pathSafety';

vi.mock('../../utils/electronHost', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/electronHost')>()),
  canonicalizeElectronPathForPolicy: vi.fn().mockResolvedValue(null),
}));

const HOME = '/Users/testuser';

describe('pathSafety · what a write grant covers', () => {
  beforeEach(() => {
    vi.mocked(canonicalizeElectronPathForPolicy).mockReset();
    vi.mocked(canonicalizeElectronPathForPolicy).mockResolvedValue(null);
    vi.mocked(lstat).mockReset();
    vi.mocked(lstat).mockResolvedValue({ isSymlink: false } as never);
  });

  it('asks for the top-level folder of home for a write below it (once for the folder)', async () => {
    const result = await checkWritePath(`${HOME}/Documents/reports/2026/q3.xlsx`);
    expect(result).toMatchObject({ needsPermission: true, permissionPath: `${HOME}/Documents`, permissionIsFolder: true, capability: 'write' });
  });

  it('asks for the folder holding the file on another volume, so the next file beside it asks nothing', async () => {
    const first = await checkWritePath('/Volumes/Work/reports/q3.xlsx');
    expect(first).toMatchObject({ needsPermission: true, permissionPath: '/Volumes/Work/reports', permissionIsFolder: true });

    authorizeWorkspace(first.permissionPath!, ['read', 'write']);
    try {
      expect((await checkWritePath('/Volumes/Work/reports/q4.xlsx')).allowed).toBe(true);
      expect((await checkWritePath('/Volumes/Work/other/q4.xlsx')).allowed).toBe(false);
    } finally {
      revokeWorkspace(first.permissionPath!);
    }
  });

  it('keeps the file as the unit where no safe folder exists', async () => {
    const result = await checkWritePath('/solo.txt');
    expect(result.needsPermission).toBe(true);
    expect(result.permissionPath).toBe('/solo.txt');
    expect(result.permissionIsFolder).toBeUndefined();
  });

  it('never offers a system folder, which is refused before any question', async () => {
    const result = await checkWritePath('/etc/hosts');
    expect(result.allowed).toBe(false);
    expect(result.needsPermission).toBeUndefined();
  });

  it('does not offer the home folder, or a folder above it, as a write grant', async () => {
    for (const path of [HOME, `${HOME}/`, '/Users']) {
      const result = await checkWritePath(path);
      expect(result.allowed, path).toBe(false);
      expect(result.needsPermission, path).toBeUndefined();
      expect(result.denialKind, path).toBe('blocked');
    }
  });

  it('does not offer home through an alias of it on another path', async () => {
    vi.mocked(canonicalizeElectronPathForPolicy).mockImplementation(async (candidate) => {
      const value = String(candidate);
      return value.startsWith('/Volumes/Mac/Users/testuser') ? value.replace('/Volumes/Mac', '') : value;
    });
    const result = await checkWritePath('/Volumes/Mac/Users/testuser/notes.txt');
    expect(result.permissionIsFolder).toBeUndefined();
    expect(result.permissionPath).not.toBe('/Volumes/Mac/Users/testuser');
  });

  it('refuses a write below a home grant that a home-wide grant would have made reachable', async () => {
    authorizeWorkspace(`${HOME}/Documents`, ['write']);
    try {
      expect((await checkWritePath(`${HOME}/Library/LaunchAgents/x.plist`)).allowed).toBe(false);
      expect((await checkWritePath(`${HOME}/Documents/a.txt`)).allowed).toBe(true);
    } finally {
      revokeWorkspace(`${HOME}/Documents`);
    }
  });

  it.each([HOME, '/Users'])('a grant of %s reads but never writes: the home folder is not a write unit', async (root) => {
    authorizeWorkspace(root, ['read', 'write']);
    try {
      expect((await checkReadPath(`${HOME}/Documents/a.txt`)).allowed).toBe(true);
      expect((await checkWritePath(`${HOME}/Library/Application Support/Foo/x.txt`)).allowed).toBe(false);
      expect((await checkWritePath(`${HOME}/.config/git/hooks/pre-commit`)).allowed).toBe(false);
      const documents = await checkWritePath(`${HOME}/Documents/a.txt`);
      expect(documents).toMatchObject({ allowed: false, needsPermission: true, permissionPath: `${HOME}/Documents` });
      expect(getAuthorizedWritablePaths()).not.toContain(root);
    } finally {
      revokeWorkspace(root);
    }
  });

  it('a home alias of another spelling is not a write unit either', async () => {
    vi.mocked(canonicalizeElectronPathForPolicy).mockImplementation(async (candidate) => {
      const value = String(candidate);
      return value.startsWith('/Volumes/Mac/Users/testuser') ? value.replace('/Volumes/Mac', '') : value;
    });
    authorizeWorkspace('/Volumes/Mac/Users/testuser', ['read', 'write']);
    try {
      expect((await checkWritePath(`${HOME}/Library/Application Support/Foo/x.txt`)).allowed).toBe(false);
    } finally {
      revokeWorkspace('/Volumes/Mac/Users/testuser');
    }
  });

  it.each([
    ['/Applications/Tool.app/Contents/x.plist', '/Applications/Tool.app/Contents/x.plist'],
    ['/opt/homebrew/bin/tool', '/opt/homebrew/bin/tool'],
  ])('keeps a write to %s per file: no folder grant on a program folder', async (target, unit) => {
    const result = await checkWritePath(target);
    expect(result.needsPermission).toBe(true);
    expect(result.permissionPath).toBe(unit);
    expect(result.permissionIsFolder).toBeUndefined();
  });
});
