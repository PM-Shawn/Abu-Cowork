import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { lstat } from '@tauri-apps/plugin-fs';
import { canonicalizeElectronPathForPolicy } from '../../utils/electronHost';
import { authorizeWorkspace, checkListPath, isReadClosed, revokeWorkspace } from './pathSafety';

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

describe('pathSafety · a read of home does not open the system folders inside it (macOS)', () => {
  const HOME = '/Users/testuser';
  beforeEach(resetHost);
  afterEach(() => {
    revokeWorkspace(HOME);
    revokeWorkspace(`${HOME}/Library/Mobile Documents/com~apple~CloudDocs/Work`);
  });

  it('lists a folder of home through a grant of home', async () => {
    authorizeWorkspace(HOME, ['read']);
    expect((await checkListPath(`${HOME}/Documents`)).allowed).toBe(true);
  });

  it('does not list ~/Library or the trash through a grant of home, in any spelling of the case', async () => {
    authorizeWorkspace(HOME, ['read']);
    for (const path of [`${HOME}/Library`, `${HOME}/Library/Messages`, `${HOME}/library`, `${HOME}/.Trash`]) {
      const result = await checkListPath(path);
      expect(result.allowed, path).toBe(false);
      expect(result.needsPermission, path).toBeUndefined();
    }
  });

  it('still lists a folder the user granted inside Library (an iCloud Drive folder)', async () => {
    const granted = `${HOME}/Library/Mobile Documents/com~apple~CloudDocs/Work`;
    authorizeWorkspace(granted, ['read']);
    expect((await checkListPath(`${granted}/2026`)).allowed).toBe(true);
    expect((await checkListPath(`${HOME}/Library/Mobile Documents`)).allowed).toBe(false);
  });
});

describe('pathSafety · isReadClosed', () => {
  beforeEach(resetHost);
  it('is the read check\'s hard-block verdict on one path, with no grant involved', async () => {
    expect(await isReadClosed('/Users/testuser/.ssh/id_rsa')).toBe(true);
    expect(await isReadClosed('/Users/testuser/Library/Application Support/Abu/secrets.json')).toBe(true);
    expect(await isReadClosed('/Users/testuser/Documents/a.txt')).toBe(false);
    expect(await isReadClosed('/Users/testuser/proj/.env.example')).toBe(false);
  });
  it('counts a path that is not absolute as closed', async () => {
    expect(await isReadClosed('relative/a.txt')).toBe(true);
  });
});
