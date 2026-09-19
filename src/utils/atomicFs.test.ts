import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  atomicWrite,
  atomicWriteWithBackup,
  restoreFromBackup,
  cleanupOldBackups,
} from './atomicFs';

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('atomicFs', () => {
  describe('atomicWrite', () => {
    it('calls invoke with atomic_write_text and forwards path + content', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);
      await atomicWrite('/tmp/foo.txt', 'hello');
      expect(mockInvoke).toHaveBeenCalledWith('atomic_write_text', {
        path: '/tmp/foo.txt',
        content: 'hello',
      });
    });

    it('propagates errors from the Rust side', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('disk full'));
      await expect(atomicWrite('/x', 'y')).rejects.toThrow('disk full');
    });

    it('#549: in the Electron renderer, sends the content as a raw UTF-8 body with only a path header', async () => {
      (globalThis as { __ABU_SHELL__?: unknown }).__ABU_SHELL__ = { mainSupervisesSidecar: true };
      try {
        mockInvoke.mockResolvedValueOnce(undefined);
        await atomicWrite('/tmp/a b/中.json', '{"k":"中"}');
        const [cmd, body, options] = mockInvoke.mock.calls[0] as unknown as [string, Uint8Array, { headers: Record<string, string> }];
        expect(cmd).toBe('atomic_write_text');
        expect(body).toBeInstanceOf(Uint8Array);
        expect(new TextDecoder().decode(body)).toBe('{"k":"中"}');
        expect(options).toEqual({ headers: { path: encodeURIComponent('/tmp/a b/中.json') } });
      } finally {
        delete (globalThis as { __ABU_SHELL__?: unknown }).__ABU_SHELL__;
      }
    });
  });

  describe('atomicWriteWithBackup', () => {
    it('returns camelCased result when backup is created', async () => {
      mockInvoke.mockResolvedValueOnce({ wrote: true, backup_path: '/tmp/.foo.backup.123' });
      const result = await atomicWriteWithBackup('/tmp/foo.txt', 'new');
      expect(result).toEqual({ wrote: true, backupPath: '/tmp/.foo.backup.123' });
    });

    it('returns null backupPath when target did not exist', async () => {
      mockInvoke.mockResolvedValueOnce({ wrote: true, backup_path: null });
      const result = await atomicWriteWithBackup('/tmp/new.txt', 'first');
      expect(result).toEqual({ wrote: true, backupPath: null });
    });
  });

  describe('restoreFromBackup', () => {
    it('passes target and backup verbatim', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);
      await restoreFromBackup('/tmp/foo.txt', '/tmp/.foo.backup.123');
      expect(mockInvoke).toHaveBeenCalledWith('restore_from_backup', {
        target: '/tmp/foo.txt',
        backup: '/tmp/.foo.backup.123',
      });
    });
  });

  describe('cleanupOldBackups', () => {
    it('returns count of files removed', async () => {
      mockInvoke.mockResolvedValueOnce(7);
      const count = await cleanupOldBackups('/tmp/memdir', 24);
      expect(count).toBe(7);
      expect(mockInvoke).toHaveBeenCalledWith('cleanup_old_backups', {
        dir: '/tmp/memdir',
        ttlHours: 24,
      });
    });
  });
});
