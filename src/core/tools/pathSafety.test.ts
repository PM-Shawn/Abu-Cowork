import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  checkReadPath,
  checkWritePath,
  checkListPath,
  authorizeWorkspace,
  revokeWorkspace,
  getPermissionDirectory,
  isCatastrophicDeleteTarget,
} from './pathSafety';
import { setPlatformForTest } from '../../test/helpers';

describe('pathSafety', () => {
  beforeEach(() => {
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
});
