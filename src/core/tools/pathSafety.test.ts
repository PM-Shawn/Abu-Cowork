import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { lstat } from '@tauri-apps/plugin-fs';
import {
  checkReadPath,
  checkWritePath,
  checkListPath,
  authorizeWorkspace,
  createAuthorizationScope,
  disposeAuthorizationScope,
  getAuthorizedWritablePaths,
  hasFullShellAuthorizationScope,
  revokeWorkspace,
  scopedAuthorizeWorkspace,
  getPermissionDirectory,
  isCatastrophicDeleteTarget,
} from './pathSafety';
import { setPlatformForTest } from '../../test/helpers';

describe('pathSafety', () => {
  beforeEach(() => {
    vi.mocked(lstat).mockReset();
    vi.mocked(lstat).mockResolvedValue({ isSymlink: false } as never);
    // Clear any authorized workspaces by revoking known ones
    revokeWorkspace('/Users/testuser/Projects/myapp');
    revokeWorkspace('/tmp/test');
  });

  // ── Blocked paths ──
  describe('blocked paths', () => {
    const blockedPaths = [
      '/Users/testuser/.ssh/id_rsa',
      '/Users/testuser/.aws/credentials',
      '/Users/testuser/.config/gcloud/credentials',
      '/Users/testuser/.gnupg/secring.gpg',
      '/Users/testuser/.netrc',
      '/Users/testuser/.npmrc',
      '/Users/testuser/.bashrc',
      '/Users/testuser/.zshrc',
      '/Users/testuser/.git-credentials',
      '/Users/testuser/.env',
      '/Users/testuser/.env.local',
      '/Users/testuser/.env.production',
      '/Users/testuser/.password-store/key',
    ];

    for (const path of blockedPaths) {
      it(`blocks read: ${path}`, async () => {
        const result = await checkReadPath(path);
        expect(result.allowed).toBe(false);
        expect(result.reason).toBeDefined();
      });

      it(`blocks write: ${path}`, async () => {
        const result = await checkWritePath(path);
        expect(result.allowed).toBe(false);
      });
    }

    it('blocks system sensitive reads', async () => {
      const result = await checkReadPath('/etc/shadow');
      expect(result.allowed).toBe(false);
    });

    it('blocks system sensitive reads (macOS)', async () => {
      const result = await checkReadPath('/private/etc/master.passwd');
      expect(result.allowed).toBe(false);
    });
  });

  // ── System write blocks ──
  describe('system write blocks', () => {
    const sysPaths = ['/etc/hosts', '/usr/local/bin/node', '/bin/sh', '/sbin/init', '/System/Library', '/Library/Preferences'];

    for (const path of sysPaths) {
      it(`blocks write: ${path}`, async () => {
        const result = await checkWritePath(path);
        expect(result.allowed).toBe(false);
      });
    }
  });

  // ── Always allowed paths ──
  describe('always allowed paths', () => {
    for (const path of ['/tmp/testfile', '/private/tmp/bar']) {
      it(`allows read: ${path}`, async () => {
        const result = await checkReadPath(path);
        expect(result.allowed).toBe(true);
      });

      it(`allows write: ${path}`, async () => {
        const result = await checkWritePath(path);
        expect(result.allowed).toBe(true);
      });
    }

    // /var/tmp is always-allowed for read, but /var is write-blocked at system level
    it('allows read: /var/tmp/foo', async () => {
      const result = await checkReadPath('/var/tmp/foo');
      expect(result.allowed).toBe(true);
    });

    it('blocks write: /var/tmp/foo (system path /var)', async () => {
      const result = await checkWritePath('/var/tmp/foo');
      expect(result.allowed).toBe(false);
    });
  });

  // ── Workspace authorization ──
  describe('workspace authorization', () => {
    it('allows read after authorizing workspace', async () => {
      authorizeWorkspace('/Users/testuser/Projects/myapp');
      const result = await checkReadPath('/Users/testuser/Projects/myapp/src/index.ts');
      expect(result.allowed).toBe(true);
    });

    it('allows write after authorizing workspace', async () => {
      authorizeWorkspace('/Users/testuser/Projects/myapp');
      const result = await checkWritePath('/Users/testuser/Projects/myapp/src/index.ts');
      expect(result.allowed).toBe(true);
    });

    it('revokes workspace access', async () => {
      authorizeWorkspace('/Users/testuser/Projects/myapp');
      revokeWorkspace('/Users/testuser/Projects/myapp');
      const result = await checkReadPath('/Users/testuser/Projects/myapp/src/index.ts');
      expect(result.allowed).toBe(false);
    });

    it('normalizes backslashes in workspace path', async () => {
      authorizeWorkspace('C:\\Users\\testuser\\Projects\\myapp');
      const result = await checkReadPath('C:/Users/testuser/Projects/myapp/src/index.ts');
      expect(result.allowed).toBe(true);
      revokeWorkspace('C:\\Users\\testuser\\Projects\\myapp');
    });

    it('exact workspace path is authorized', async () => {
      authorizeWorkspace('/Users/testuser/Projects/myapp');
      const result = await checkReadPath('/Users/testuser/Projects/myapp');
      expect(result.allowed).toBe(true);
    });

    it('rejects a scoped path whose parent component is a symlink', async () => {
      const ws = '/Users/testuser/Projects/symlink-scope';
      const scopeId = createAuthorizationScope();
      scopedAuthorizeWorkspace(scopeId, ws, ['read', 'write']);
      vi.mocked(lstat).mockImplementation(async (candidate) => ({
        isSymlink: String(candidate).endsWith('/link'),
      }) as never);

      try {
        const escapedPath = `${ws}/link/outside.txt`;
        expect((await checkReadPath(escapedPath, scopeId)).allowed).toBe(false);
        expect((await checkWritePath(escapedPath, scopeId)).allowed).toBe(false);
      } finally {
        disposeAuthorizationScope(scopeId);
      }
    });

    it('starts symlink inspection inside the Electron file capability root', async () => {
      const ws = '/Users/testuser/Projects/electron-scope';
      const scopeId = createAuthorizationScope();
      scopedAuthorizeWorkspace(scopeId, ws, ['read']);
      vi.mocked(lstat).mockImplementation(async (candidate) => {
        if (String(candidate) === '/Users') {
          throw new Error('fs: path is outside the allowed scope: /Users');
        }
        return { isSymlink: false } as never;
      });

      try {
        expect((await checkReadPath(`${ws}/notes.txt`, scopeId)).allowed).toBe(true);
        expect(lstat).not.toHaveBeenCalledWith('/Users');
      } finally {
        disposeAuthorizationScope(scopeId);
      }
    });

    it('keeps an explicit read-only scope from inheriting a global write grant on the same path', async () => {
      const ws = '/Users/testuser/Projects/scoped-global';
      revokeWorkspace(ws);
      authorizeWorkspace(ws, ['read', 'write']);
      const scopeId = createAuthorizationScope();
      try {
        scopedAuthorizeWorkspace(scopeId, ws, ['read']);

        expect((await checkReadPath(`${ws}/notes.md`, scopeId)).allowed).toBe(true);
        const scopedWrite = await checkWritePath(`${ws}/out.md`, scopeId);
        expect(scopedWrite.allowed).toBe(false);
        expect(scopedWrite.needsPermission).toBe(true);
        expect((await checkWritePath(`${ws}/out.md`)).allowed).toBe(true);
      } finally {
        disposeAuthorizationScope(scopeId);
        revokeWorkspace(ws);
      }
    });

    it('keeps concurrent scopes isolated and fails closed after disposal without touching global state', async () => {
      const wsA = '/Users/testuser/Projects/scope-a';
      const wsB = '/Users/testuser/Projects/scope-b';
      const globalWs = '/Users/testuser/Projects/global-only';
      revokeWorkspace(wsA);
      revokeWorkspace(wsB);
      revokeWorkspace(globalWs);
      authorizeWorkspace(globalWs, ['read', 'write']);
      const scopeA = createAuthorizationScope();
      const scopeB = createAuthorizationScope();
      try {
        scopedAuthorizeWorkspace(scopeA, wsA, ['read']);
        scopedAuthorizeWorkspace(scopeB, wsB, ['read', 'write']);

        expect((await checkReadPath(`${wsA}/a.txt`, scopeA)).allowed).toBe(true);
        expect((await checkWritePath(`${wsA}/a.txt`, scopeA)).allowed).toBe(false);
        expect((await checkWritePath(`${wsA}/a.txt`, scopeB)).allowed).toBe(false);
        expect((await checkWritePath(`${wsB}/b.txt`, scopeB)).allowed).toBe(true);
        expect(getAuthorizedWritablePaths(scopeB)).toEqual([wsB]);

        disposeAuthorizationScope(scopeA);

        expect((await checkReadPath(`${wsA}/a.txt`, scopeA)).allowed).toBe(false);
        expect(getAuthorizedWritablePaths(scopeA)).toEqual([]);
        expect((await checkWritePath(`${globalWs}/g.txt`)).allowed).toBe(true);
        expect((await checkWritePath(`${wsB}/b.txt`, scopeB)).allowed).toBe(true);
      } finally {
        disposeAuthorizationScope(scopeB);
        revokeWorkspace(wsA);
        revokeWorkspace(wsB);
        revokeWorkspace(globalWs);
      }
    });

    it('keeps full shell policy scoped to the live authorization scope', () => {
      const strictScope = createAuthorizationScope();
      const fullScope = createAuthorizationScope({ shell: 'full' });
      try {
        expect(hasFullShellAuthorizationScope(strictScope)).toBe(false);
        expect(hasFullShellAuthorizationScope(fullScope)).toBe(true);
        expect(hasFullShellAuthorizationScope('missing-scope')).toBe(false);

        disposeAuthorizationScope(fullScope);
        expect(hasFullShellAuthorizationScope(fullScope)).toBe(false);
      } finally {
        disposeAuthorizationScope(strictScope);
        disposeAuthorizationScope(fullScope);
      }
    });

    it('scopedAuthorizeWorkspace never falls back to global authorization when scope is missing', async () => {
      const ws = '/Users/testuser/Projects/missing-scope';
      revokeWorkspace(ws);
      try {
        scopedAuthorizeWorkspace(undefined as unknown as string, ws, ['read', 'write']);
        scopedAuthorizeWorkspace('missing-scope', ws, ['read', 'write']);
        scopedAuthorizeWorkspace('', ws, ['read', 'write']);

        expect((await checkReadPath(`${ws}/notes.md`)).allowed).toBe(false);
        expect((await checkWritePath(`${ws}/out.md`)).allowed).toBe(false);
        expect((await checkWritePath(`${ws}/out.md`, '')).allowed).toBe(false);
        expect(getAuthorizedWritablePaths('')).toEqual([]);
      } finally {
        revokeWorkspace(ws);
      }
    });

    it('treats an empty explicit scope as scoped fail-closed instead of global fallback', async () => {
      const ws = '/Users/testuser/Projects/empty-scope-global';
      revokeWorkspace(ws);
      authorizeWorkspace(ws, ['read', 'write']);
      try {
        expect((await checkWritePath(`${ws}/global.md`)).allowed).toBe(true);
        expect((await checkWritePath(`${ws}/scoped.md`, '')).allowed).toBe(false);
      } finally {
        revokeWorkspace(ws);
      }
    });

    it('ignores empty and whitespace-only global grants instead of matching every absolute path', async () => {
      authorizeWorkspace('', ['read', 'write']);
      authorizeWorkspace('   ', ['read', 'write']);

      const read = await checkReadPath('/Users/testuser/Documents/notes.md');
      const write = await checkWritePath('/Users/testuser/Documents/notes.md');

      expect(read.allowed).toBe(false);
      expect(read.needsPermission).toBe(true);
      expect(write.allowed).toBe(false);
      expect(write.needsPermission).toBe(true);
    });

    it('ignores empty and whitespace-only scoped grants instead of exposing scoped writable paths', async () => {
      const scopeId = createAuthorizationScope();
      try {
        scopedAuthorizeWorkspace(scopeId, '', ['read', 'write']);
        scopedAuthorizeWorkspace(scopeId, '\t  ', ['read', 'write']);

        const write = await checkWritePath('/Users/testuser/Documents/notes.md', scopeId);

        expect(write.allowed).toBe(false);
        expect(write.needsPermission).toBe(true);
        expect(getAuthorizedWritablePaths(scopeId)).toEqual([]);
      } finally {
        disposeAuthorizationScope(scopeId);
      }
    });

    it('preserves legal spaces in authorized paths rather than trimming them into a different path', async () => {
      const ws = '/Users/testuser/Projects/project with trailing space ';
      const trimmedWs = '/Users/testuser/Projects/project with trailing space';
      revokeWorkspace(ws);
      revokeWorkspace(trimmedWs);
      try {
        authorizeWorkspace(ws, ['read']);

        expect((await checkReadPath(`${ws}/notes.md`)).allowed).toBe(true);
        expect((await checkReadPath(`${trimmedWs}/notes.md`)).allowed).toBe(false);
      } finally {
        revokeWorkspace(ws);
        revokeWorkspace(trimmedWs);
      }
    });
  });

  // ── Path traversal ──
  describe('path traversal prevention', () => {
    it('normalizes .. traversal', async () => {
      const result = await checkReadPath('/Users/testuser/Desktop/../.ssh/id_rsa');
      expect(result.allowed).toBe(false);
    });

    it('normalizes redundant slashes', async () => {
      const result = await checkReadPath('/Users/testuser//.ssh//id_rsa');
      expect(result.allowed).toBe(false);
    });
  });

  // ── Permission-needed paths ──
  describe('permission-needed paths', () => {
    it('needs permission for ~/Desktop', async () => {
      const result = await checkReadPath('/Users/testuser/Desktop/file.txt');
      expect(result.allowed).toBe(false);
      expect(result.needsPermission).toBe(true);
      expect(result.permissionPath).toContain('Desktop');
      expect(result.capability).toBe('read');
    });

    it('needs write permission for ~/Documents', async () => {
      const result = await checkWritePath('/Users/testuser/Documents/file.txt');
      expect(result.allowed).toBe(false);
      expect(result.needsPermission).toBe(true);
      expect(result.capability).toBe('write');
    });

    it('needs permission for ~/Projects', async () => {
      const result = await checkReadPath('/Users/testuser/Projects/myapp/src/index.ts');
      expect(result.allowed).toBe(false);
      expect(result.needsPermission).toBe(true);
    });
  });

  // ── checkListPath ──
  describe('checkListPath', () => {
    it('blocks sensitive directories', async () => {
      const result = await checkListPath('/Users/testuser/.ssh');
      expect(result.allowed).toBe(false);
    });

    it('allows authorized workspace listing', async () => {
      authorizeWorkspace('/Users/testuser/Projects/myapp');
      const result = await checkListPath('/Users/testuser/Projects/myapp/src');
      expect(result.allowed).toBe(true);
    });

    it('allows /tmp listing', async () => {
      const result = await checkListPath('/tmp');
      expect(result.allowed).toBe(true);
    });

    it('blocks Library listing', async () => {
      const result = await checkListPath('/Users/testuser/Library');
      expect(result.allowed).toBe(false);
    });

    it('needs permission for home subdirectories', async () => {
      const result = await checkListPath('/Users/testuser/Desktop');
      expect(result.allowed).toBe(false);
      expect(result.needsPermission).toBe(true);
    });
  });

  // ── getPermissionDirectory ──
  describe('getPermissionDirectory', () => {
    it('extracts first subdirectory under home', () => {
      const result = getPermissionDirectory(
        '/Users/testuser/Desktop/foo/bar',
        '/Users/testuser'
      );
      expect(result).toBe('/Users/testuser/Desktop');
    });

    it('returns home for home path itself', () => {
      const result = getPermissionDirectory('/Users/testuser', '/Users/testuser');
      expect(result).toBe('/Users/testuser');
    });

    it('returns path itself for non-home paths', () => {
      const result = getPermissionDirectory('/tmp/foo', '/Users/testuser');
      expect(result).toBe('/tmp/foo');
    });
  });

  // ── isCatastrophicDeleteTarget ──
  describe('isCatastrophicDeleteTarget', () => {
    let cleanup: (() => void) | undefined;

    afterEach(() => {
      cleanup?.();
      cleanup = undefined;
    });

    it('flags the POSIX filesystem root', async () => {
      expect(await isCatastrophicDeleteTarget('/')).toBe(true);
    });

    it('flags the home directory itself', async () => {
      expect(await isCatastrophicDeleteTarget('/Users/testuser')).toBe(true);
    });

    it('flags the home directory with a trailing slash', async () => {
      expect(await isCatastrophicDeleteTarget('/Users/testuser/')).toBe(true);
    });

    it('does not flag a normal subdirectory of home', async () => {
      expect(await isCatastrophicDeleteTarget('/Users/testuser/Projects/myapp')).toBe(false);
    });

    it('does not flag an unrelated absolute path', async () => {
      expect(await isCatastrophicDeleteTarget('/tmp/foo')).toBe(false);
    });

    it('flags a Windows drive root (forward slash)', async () => {
      cleanup = setPlatformForTest('windows');
      expect(await isCatastrophicDeleteTarget('C:/')).toBe(true);
    });

    it('flags a Windows drive root (backslash)', async () => {
      cleanup = setPlatformForTest('windows');
      expect(await isCatastrophicDeleteTarget('C:\\')).toBe(true);
    });

    it('flags a lowercase Windows drive root', async () => {
      cleanup = setPlatformForTest('windows');
      expect(await isCatastrophicDeleteTarget('c:/')).toBe(true);
    });

    it('does not flag a normal Windows path', async () => {
      cleanup = setPlatformForTest('windows');
      expect(await isCatastrophicDeleteTarget('C:/Users/testuser/Projects/myapp')).toBe(false);
    });
  });

  // ── Windows-specific paths ──
  describe('Windows paths', () => {
    let cleanup: () => void;

    afterEach(() => {
      cleanup?.();
    });

    it('blocks Windows credential paths', async () => {
      cleanup = setPlatformForTest('windows');
      const result = await checkReadPath('/Users/testuser/AppData/Local/Microsoft/Credentials/secret');
      expect(result.allowed).toBe(false);
    });

    it('blocks Windows system write paths', async () => {
      cleanup = setPlatformForTest('windows');
      const result = await checkWritePath('C:/Windows/System32/config');
      expect(result.allowed).toBe(false);
    });

    it('allows Windows temp directory', async () => {
      cleanup = setPlatformForTest('windows');
      const result = await checkReadPath('/Users/testuser/AppData/Local/Temp/file.txt');
      expect(result.allowed).toBe(true);
    });

    // Case-insensitive matching on Windows
    it('blocks .SSH (uppercase) same as .ssh on Windows', async () => {
      cleanup = setPlatformForTest('windows');
      const result = await checkReadPath('/Users/testuser/.SSH/id_rsa');
      expect(result.allowed).toBe(false);
    });

    it('blocks .Env (mixed case) same as .env on Windows', async () => {
      cleanup = setPlatformForTest('windows');
      const result = await checkReadPath('/Users/testuser/.Env');
      expect(result.allowed).toBe(false);
    });

    it('blocks system write with different drive case on Windows', async () => {
      cleanup = setPlatformForTest('windows');
      const result = await checkWritePath('c:/windows/system32/drivers');
      expect(result.allowed).toBe(false);
    });

    it('blocks .AWS (uppercase) on Windows', async () => {
      cleanup = setPlatformForTest('windows');
      const result = await checkReadPath('/Users/testuser/.AWS/credentials');
      expect(result.allowed).toBe(false);
    });

    // Drive letter normalization
    it('normalizes lowercase drive letter c: to C:', async () => {
      cleanup = setPlatformForTest('windows');
      const result = await checkWritePath('c:/Windows/System32/config');
      expect(result.allowed).toBe(false);
    });
  });

  // ── UNC path blocking ──
  describe('UNC paths', () => {
    it('blocks UNC paths with backslashes for read', async () => {
      const result = await checkReadPath('\\\\server\\share\\file.txt');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('UNC');
    });

    it('blocks UNC paths with forward slashes for read', async () => {
      const result = await checkReadPath('//server/share/file.txt');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('UNC');
    });

    it('blocks UNC paths for write', async () => {
      const result = await checkWritePath('\\\\server\\share\\file.txt');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('UNC');
    });

    it('blocks UNC paths for list', async () => {
      const result = await checkListPath('//server/share');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('UNC');
    });
  });

  // ── Long path prefix ──
  describe('Windows long path prefix', () => {
    it('strips \\\\?\\ prefix and checks path normally', async () => {
      const result = await checkReadPath('\\\\?\\C:\\Users\\testuser\\.ssh\\id_rsa');
      expect(result.allowed).toBe(false);
    });

    it('strips //?/ prefix and checks path normally', async () => {
      const result = await checkReadPath('//?/C:/Users/testuser/.ssh/id_rsa');
      expect(result.allowed).toBe(false);
    });

    it('does not treat //?/ prefix as UNC path', async () => {
      // //?/C:/tmp/file should NOT be blocked as UNC
      const result = await checkReadPath('//?/C:/tmp/file.txt');
      // Should not get UNC error — it should be treated as C:/tmp/file.txt
      expect(result.reason ?? '').not.toContain('UNC');
    });
  });

  // ── Abu's own config and state (self-protection red line, §4.6 ②) ──
  //
  // These paths used to fall through checkWritePath's final "offer a
  // permission dialog" branch, which resolves to an automatic ALLOW under
  // permissionMode 'autonomous' — so a generic write_file could rewrite the
  // agent definitions, the MCP config, the persisted permission settings, or
  // the scheduled task definitions without anyone being asked, bypassing the
  // selfExtension confirmation that save_agent/manage_mcp_server go through.
  describe('Abu self-managed paths', () => {
    let cleanup: (() => void) | undefined;

    afterEach(() => {
      cleanup?.();
      cleanup = undefined;
      revokeWorkspace('/Users/testuser');
    });

    const blockedWrites = [
      '/Users/testuser/.abu/agents/my-agent/AGENT.md',
      '/Users/testuser/.abu/skills/my-skill/SKILL.md',
      '/Users/testuser/.abu/mcp/config.json',
      '/Users/testuser/.abu/task-log.json',
      '/Users/testuser/Library/Application Support/Abu/Local Storage/leveldb/000003.log',
      '/Users/testuser/Library/Application Support/abu-electron-dev/config.json',
      '/Users/testuser/Library/Application Support/com.abu.app/secrets.bin',
      '/Users/testuser/Library/Application Support/com.abu.app.dev/secrets.bin',
    ];

    for (const path of blockedWrites) {
      it(`blocks write: ${path}`, async () => {
        const result = await checkWritePath(path);
        expect(result.allowed).toBe(false);
        expect(result.needsPermission).toBeUndefined();
      });
    }

    it('still allows writes to the memory directories the agent maintains', async () => {
      expect((await checkWritePath('/Users/testuser/.abu/memory/user_name.md')).allowed).toBe(true);
      expect(
        (await checkWritePath('/Users/testuser/.abu/projects/-ws-app/memory/notes.md')).allowed,
      ).toBe(true);
    });

    it('is not overridden by an authorized parent workspace', async () => {
      // Authorizing the home dir (or any ancestor) must not hand over write
      // access to Abu's own config — the guard runs before the workspace
      // shortcut for exactly this reason.
      authorizeWorkspace('/Users/testuser');
      const result = await checkWritePath('/Users/testuser/.abu/mcp/config.json');
      expect(result.allowed).toBe(false);
    });

    it('leaves unrelated Application Support apps alone', async () => {
      const result = await checkWritePath(
        '/Users/testuser/Library/Application Support/SomeOtherApp/config.json',
      );
      expect(result.allowed).toBe(false);
      expect(result.reason ?? '').not.toContain('阿布');
      // Still dialog-eligible, just not hard-blocked as one of ours.
      expect(result.needsPermission).toBe(true);
    });

    // macOS (APFS/HFS+ default) and Windows are case-INsensitive: `~/.Abu` and
    // `~/.abu` are the same directory on disk. A case-sensitive prefix test
    // therefore hands the whole red line away for one capital letter — and with
    // the home directory authorized (the common case once a workspace under
    // home is granted) the bypass resolved to a plain `allowed: true`.
    const caseVariants = [
      '/Users/testuser/.Abu/mcp/config.json',
      '/Users/testuser/.ABU/agents/x/AGENT.md',
      '/Users/testuser/Library/Application Support/ABU/config.json',
      '/Users/testuser/library/Application Support/Abu/config.json',
    ];

    for (const path of caseVariants) {
      it(`blocks the case variant: ${path}`, async () => {
        authorizeWorkspace('/Users/testuser');
        const result = await checkWritePath(path);
        expect(result.allowed).toBe(false);
        expect(result.needsPermission).toBeUndefined();
      });
    }

    it('keeps the memory carve-out working on Windows', async () => {
      // getHomeDir() is not lowercased but normalizePath lowercases the whole
      // path on Windows, so an unfolded `${home}/.abu` prefix never matched —
      // which flipped the memory whitelist to a hard block on that platform.
      cleanup = setPlatformForTest('windows');
      expect((await checkWritePath('/Users/testuser/.abu/memory/user_name.md')).allowed).toBe(true);
      expect(
        (await checkWritePath('/Users/testuser/.abu/projects/-ws-app/memory/notes.md')).allowed,
      ).toBe(true);
      // …while the rest of the tree stays blocked there.
      expect((await checkWritePath('/Users/testuser/.abu/mcp/config.json')).allowed).toBe(false);
    });

    it('covers the Windows app-data root', async () => {
      cleanup = setPlatformForTest('windows');
      // Home-relative, matching how the other Windows cases are written (the
      // mocked homeDir carries no drive letter). Mixed case exercises the
      // case-insensitive segment match.
      const result = await checkWritePath('/Users/testuser/AppData/Roaming/ABU/config.json');
      expect(result.allowed).toBe(false);
      expect(result.needsPermission).toBeUndefined();
    });

    it('does not block reads — the threat is rewriting config, not seeing it', async () => {
      // Blocking reads would break the memory tools and the skill loader; the
      // §4.6 red line is about modification.
      const result = await checkReadPath('/Users/testuser/.abu/skills/my-skill/SKILL.md');
      expect(result.reason ?? '').not.toContain('阿布');
    });
  });
});
