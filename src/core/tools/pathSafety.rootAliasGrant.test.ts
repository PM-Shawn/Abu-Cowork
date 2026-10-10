import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tempDir } from '@tauri-apps/api/path';
import { lstat } from '@tauri-apps/plugin-fs';
import { canonicalizeElectronPathForPolicy } from '../../utils/electronHost';
import {
  authorizeWorkspace,
  checkListPath,
  checkReadPath,
  checkWritePath,
  createAuthorizationScope,
  disposeAuthorizationScope,
  getAuthorizedDirs,
  getAuthorizedWritablePaths,
  revokeWorkspace,
  scopedAuthorizeWorkspace,
} from './pathSafety';

vi.mock('../../utils/electronHost', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/electronHost')>()),
  canonicalizeElectronPathForPolicy: vi.fn().mockResolvedValue(null),
}));

const WORKSPACE = '/Users/testuser/Projects/app';
const GRANTS_USED = [
  '/',
  '/.',
  '/Users/..',
  '/Users/testuser/..',
  WORKSPACE,
  `${WORKSPACE}/sub`,
  `${WORKSPACE}/sub/..`,
  `${WORKSPACE}/./sub//`,
];

describe('pathSafety · grants whose spelling resolves to the filesystem root', () => {
  beforeEach(() => {
    vi.mocked(canonicalizeElectronPathForPolicy).mockReset();
    vi.mocked(canonicalizeElectronPathForPolicy).mockResolvedValue(null);
    vi.mocked(tempDir).mockReset();
    vi.mocked(tempDir).mockResolvedValue('/tmp');
    vi.mocked(lstat).mockReset();
    vi.mocked(lstat).mockResolvedValue({ isSymlink: false } as never);
    for (const p of GRANTS_USED) revokeWorkspace(p);
  });

  afterEach(() => {
    for (const p of GRANTS_USED) revokeWorkspace(p);
  });

  it('a bare "/" grant is dropped and grants nothing', async () => {
    authorizeWorkspace('/');
    expect(getAuthorizedDirs()).toEqual([]);
    const read = await checkReadPath('/etc/hosts');
    expect(read.allowed).toBe(false);
    expect(read.needsPermission).toBe(true);
  });

  it('a "/." grant is dropped and grants nothing', async () => {
    authorizeWorkspace('/.');
    expect(getAuthorizedDirs()).toEqual([]);
    expect(getAuthorizedWritablePaths()).toEqual([]);

    const hosts = await checkReadPath('/etc/hosts');
    expect(hosts.allowed).toBe(false);
    expect(hosts.needsPermission).toBe(true);
    expect((await checkReadPath('/Users/testuser/Pictures/holiday.png')).allowed).toBe(false);
    expect((await checkReadPath('/Users/otheruser/Documents/report.docx')).allowed).toBe(false);
    expect((await checkListPath('/Users/testuser')).allowed).toBe(false);
    expect((await checkWritePath('/Users/testuser/Projects/other-app/index.ts')).allowed).toBe(false);
    expect((await checkWritePath('/Users/testuser/Library/Preferences/com.example.plist')).allowed).toBe(false);
  });

  it('a "<top-level dir>/.." grant is dropped and grants nothing', async () => {
    authorizeWorkspace('/Users/..');
    expect(getAuthorizedDirs()).toEqual([]);
    expect((await checkReadPath('/etc/hosts')).allowed).toBe(false);
    expect((await checkWritePath('/Users/otheruser/notes.txt')).allowed).toBe(false);
  });

  it('a "<dir>/.." grant does not grant the parent folder', async () => {
    authorizeWorkspace('/Users/testuser/..');
    expect(getAuthorizedDirs()).toEqual([]);
    const own = await checkReadPath('/Users/testuser/Pictures/holiday.png');
    expect(own.allowed).toBe(false);
    expect(own.needsPermission).toBe(true);
    expect((await checkReadPath('/Users/otheruser/Documents/report.docx')).allowed).toBe(false);
    expect((await checkReadPath('/etc/hosts')).allowed).toBe(false);
  });

  it('a "<workspace>/sub/.." spelling does not enter the table', async () => {
    authorizeWorkspace(`${WORKSPACE}/sub/..`);
    expect(getAuthorizedDirs()).toEqual([]);
    const inside = await checkReadPath(`${WORKSPACE}/index.ts`);
    expect(inside.allowed).toBe(false);
    expect(inside.needsPermission).toBe(true);
  });

  it('a scoped root-alias grant is dropped inside that scope too', async () => {
    const scope = createAuthorizationScope();
    try {
      scopedAuthorizeWorkspace(scope, '/.');
      scopedAuthorizeWorkspace(scope, '/Users/..');
      expect(getAuthorizedDirs(scope)).toEqual([]);
      expect((await checkReadPath('/etc/hosts', scope)).allowed).toBe(false);
      expect((await checkWritePath('/Users/otheruser/notes.txt', scope)).allowed).toBe(false);
      expect((await checkReadPath('/etc/hosts')).allowed).toBe(false);
    } finally {
      disposeAuthorizationScope(scope);
    }
  });

  it('two spellings of one folder share one table entry and one revoke clears it', async () => {
    authorizeWorkspace(`${WORKSPACE}/./sub//`);
    authorizeWorkspace(`${WORKSPACE}/sub`);
    expect(getAuthorizedDirs()).toEqual([`${WORKSPACE}/sub`]);
    expect(getAuthorizedWritablePaths()).toEqual([`${WORKSPACE}/sub`]);
    expect(await checkReadPath(`${WORKSPACE}/sub/index.ts`)).toMatchObject({ allowed: true });
    expect((await checkReadPath(`${WORKSPACE}/index.ts`)).allowed).toBe(false);

    revokeWorkspace(`${WORKSPACE}/./sub//`);
    expect(getAuthorizedDirs()).toEqual([]);
    const afterRevoke = await checkReadPath(`${WORKSPACE}/sub/index.ts`);
    expect(afterRevoke.allowed).toBe(false);
    expect(afterRevoke.needsPermission).toBe(true);
  });

  it('a plain workspace grant keeps working', async () => {
    authorizeWorkspace(WORKSPACE);
    expect(getAuthorizedDirs()).toEqual([WORKSPACE]);
    expect(await checkReadPath(`${WORKSPACE}/index.ts`)).toMatchObject({ allowed: true });
    expect(await checkWritePath(`${WORKSPACE}/out/report.md`)).toMatchObject({ allowed: true });
    expect((await checkReadPath('/Users/testuser/Projects/other-app/index.ts')).allowed).toBe(false);
  });

  it('a "/." grant is never produced by the permission prompt path itself', async () => {
    // What the prompt would hand to authorizeWorkspace for a root-level file
    // is the normalized permissionPath, which has no "." segment left in it.
    const result = await checkWritePath('/./hosts');
    expect(result.allowed).toBe(false);
    expect(result.permissionPath).toBe('/hosts');
  });
});
