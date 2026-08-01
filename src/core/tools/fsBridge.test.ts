import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SidecarStatus } from '../sidecar/sidecarManager';

// Everything the vi.mock factories below close over must come from
// vi.hoisted() — vitest hoists vi.mock calls above all other top-level code
// (mirrors selectChatAdapter.test.ts / sidecarAdapter.test.ts's pattern).
const { getSidecarStatusMock, requestMock } = vi.hoisted(() => ({
  getSidecarStatusMock: vi.fn<() => SidecarStatus>(),
  requestMock: vi.fn(),
}));

vi.mock('../sidecar/sidecarManager', async () => {
  const actual = await vi.importActual<typeof import('../sidecar/sidecarManager')>('../sidecar/sidecarManager');
  return {
    // SidecarRpcError kept REAL (importActual) so `instanceof SidecarRpcError`
    // in fsBridge.ts's isFsErrorResponse() behaves exactly as in production.
    SidecarRpcError: actual.SidecarRpcError,
    getSidecarStatus: getSidecarStatusMock,
    request: requestMock,
  };
});

// Local override of the global @tauri-apps/plugin-fs mock (src/test/setup.ts)
// — that global mock omits readFile/stat entirely, but fsBridge.ts's local
// fallback path needs full control over all six functions for these tests.
const tauriMocks = vi.hoisted(() => ({
  readTextFile: vi.fn(),
  readFile: vi.fn(),
  writeTextFile: vi.fn(),
  readDir: vi.fn(),
  exists: vi.fn(),
  stat: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => tauriMocks);

import { SidecarRpcError } from '../sidecar/sidecarManager';
import { readTextFile, readFile, writeTextFile, readDir, exists, stat } from './fsBridge';

describe('fsBridge', () => {
  beforeEach(() => {
    getSidecarStatusMock.mockReset();
    requestMock.mockReset();
    tauriMocks.readTextFile.mockReset();
    tauriMocks.readFile.mockReset();
    tauriMocks.writeTextFile.mockReset();
    tauriMocks.readDir.mockReset();
    tauriMocks.exists.mockReset();
    tauriMocks.stat.mockReset();
  });

  describe('routing by sidecar status', () => {
    it.each<[SidecarStatus]>([['stopped'], ['starting'], ['restarting'], ['failed']])(
      'goes straight to local plugin-fs when status is %s (never calls request())',
      async (status) => {
        getSidecarStatusMock.mockReturnValue(status);
        tauriMocks.readTextFile.mockResolvedValue('local content');

        const result = await readTextFile('/foo.txt');

        expect(result).toBe('local content');
        expect(tauriMocks.readTextFile).toHaveBeenCalledWith('/foo.txt');
        expect(requestMock).not.toHaveBeenCalled();
      },
    );

    it('routes through sidecarManager.request() when status is running', async () => {
      getSidecarStatusMock.mockReturnValue('running');
      requestMock.mockResolvedValue('sidecar content');

      const result = await readTextFile('/foo.txt');

      expect(result).toBe('sidecar content');
      expect(requestMock).toHaveBeenCalledWith('fs.readTextFile', { path: '/foo.txt' }, 30_000);
      expect(tauriMocks.readTextFile).not.toHaveBeenCalled();
    });
  });

  describe('readTextFile', () => {
    it('local path forwards to plugin-fs readTextFile verbatim', async () => {
      getSidecarStatusMock.mockReturnValue('stopped');
      tauriMocks.readTextFile.mockResolvedValue('hello');
      await expect(readTextFile('/a.txt')).resolves.toBe('hello');
    });
  });

  describe('readFile — base64 -> Uint8Array binary fidelity', () => {
    it('decodes the sidecar base64 payload back to the exact original bytes', async () => {
      getSidecarStatusMock.mockReturnValue('running');
      const original = new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x80, 0x7f, 65, 66, 67]);
      const base64 = Buffer.from(original).toString('base64');
      requestMock.mockResolvedValue({ base64 });

      const result = await readFile('/binary.bin');

      expect(result).toBeInstanceOf(Uint8Array);
      expect(Array.from(result)).toEqual(Array.from(original));
    });

    it('local path returns whatever plugin-fs readFile resolves', async () => {
      getSidecarStatusMock.mockReturnValue('stopped');
      const bytes = new Uint8Array([1, 2, 3]);
      tauriMocks.readFile.mockResolvedValue(bytes);
      await expect(readFile('/x.bin')).resolves.toBe(bytes);
    });
  });

  describe('writeTextFile', () => {
    it('sidecar path sends { path, contents } and resolves void', async () => {
      getSidecarStatusMock.mockReturnValue('running');
      requestMock.mockResolvedValue(null);
      await expect(writeTextFile('/out.txt', 'body')).resolves.toBeUndefined();
      expect(requestMock).toHaveBeenCalledWith('fs.writeTextFile', { path: '/out.txt', contents: 'body' }, 30_000);
    });

    it('local path forwards to plugin-fs writeTextFile', async () => {
      getSidecarStatusMock.mockReturnValue('stopped');
      tauriMocks.writeTextFile.mockResolvedValue(undefined);
      await writeTextFile('/out.txt', 'body');
      expect(tauriMocks.writeTextFile).toHaveBeenCalledWith('/out.txt', 'body');
    });
  });

  describe('readDir', () => {
    it('sidecar path returns entries as-is (field names already match DirEntry)', async () => {
      getSidecarStatusMock.mockReturnValue('running');
      const entries = [{ name: 'a.txt', isDirectory: false, isFile: true, isSymlink: false }];
      requestMock.mockResolvedValue(entries);
      await expect(readDir('/dir')).resolves.toEqual(entries);
    });
  });

  describe('exists', () => {
    it('sidecar path returns the boolean result', async () => {
      getSidecarStatusMock.mockReturnValue('running');
      requestMock.mockResolvedValue(true);
      await expect(exists('/y')).resolves.toBe(true);
    });
  });

  describe('stat — mtime conversion', () => {
    it('converts mtimeMs (number) back to a Date', async () => {
      getSidecarStatusMock.mockReturnValue('running');
      const mtimeMs = 1_700_000_000_000;
      requestMock.mockResolvedValue({ isFile: true, isDirectory: false, isSymlink: false, size: 42, mtimeMs });

      const result = await stat('/f.txt');

      expect(result.size).toBe(42);
      expect(result.mtime).toBeInstanceOf(Date);
      expect(result.mtime?.getTime()).toBe(mtimeMs);
    });

    it('converts a null mtimeMs to null (platform reported no value)', async () => {
      getSidecarStatusMock.mockReturnValue('running');
      requestMock.mockResolvedValue({ isFile: true, isDirectory: false, isSymlink: false, size: 0, mtimeMs: null });
      const result = await stat('/f.txt');
      expect(result.mtime).toBeNull();
    });

    it('local path returns whatever plugin-fs stat resolves untouched', async () => {
      getSidecarStatusMock.mockReturnValue('stopped');
      const fileInfo = { isFile: true, isDirectory: false, isSymlink: false, size: 7, mtime: new Date(123) };
      tauriMocks.stat.mockResolvedValue(fileInfo);
      await expect(stat('/f.txt')).resolves.toBe(fileInfo);
    });
  });

  describe('transport-failure -> local-retry-once policy', () => {
    it('retries locally once on a request timeout (plain Error, not SidecarRpcError)', async () => {
      getSidecarStatusMock.mockReturnValue('running');
      requestMock.mockRejectedValue(new Error('Sidecar request "fs.readTextFile" timed out after 30000ms'));
      tauriMocks.readTextFile.mockResolvedValue('recovered locally');

      const result = await readTextFile('/slow.txt');

      expect(result).toBe('recovered locally');
      expect(requestMock).toHaveBeenCalledTimes(1);
      expect(tauriMocks.readTextFile).toHaveBeenCalledTimes(1);
    });

    it('retries locally once when the sidecar process closes mid-request', async () => {
      getSidecarStatusMock.mockReturnValue('running');
      requestMock.mockRejectedValue(new Error('Sidecar process closed'));
      tauriMocks.readTextFile.mockResolvedValue('recovered locally');

      await expect(readTextFile('/x.txt')).resolves.toBe('recovered locally');
      expect(tauriMocks.readTextFile).toHaveBeenCalledTimes(1);
    });

    it('retries locally once on a SidecarRpcError without a classifiable fs error code (generic internal error)', async () => {
      getSidecarStatusMock.mockReturnValue('running');
      requestMock.mockRejectedValue(new SidecarRpcError(-32603, 'Internal error', { message: 'unexpected' }));
      tauriMocks.readTextFile.mockResolvedValue('recovered locally');

      await expect(readTextFile('/x.txt')).resolves.toBe('recovered locally');
      expect(tauriMocks.readTextFile).toHaveBeenCalledTimes(1);
    });

    it('retries locally once on a SidecarRpcError with no data at all', async () => {
      getSidecarStatusMock.mockReturnValue('running');
      requestMock.mockRejectedValue(new SidecarRpcError(-32601, 'Method not found'));
      tauriMocks.readTextFile.mockResolvedValue('recovered locally');

      await expect(readTextFile('/x.txt')).resolves.toBe('recovered locally');
      expect(tauriMocks.readTextFile).toHaveBeenCalledTimes(1);
    });

    it('surfaces the error if the local retry ALSO fails', async () => {
      getSidecarStatusMock.mockReturnValue('running');
      requestMock.mockRejectedValue(new Error('Sidecar process closed'));
      tauriMocks.readTextFile.mockRejectedValue(new Error('ENOENT: no such file'));

      await expect(readTextFile('/x.txt')).rejects.toThrow('ENOENT: no such file');
    });
  });

  describe('real-fs-error -> no-fallback policy', () => {
    it('surfaces a real fs error (ENOENT) faithfully without retrying locally', async () => {
      getSidecarStatusMock.mockReturnValue('running');
      requestMock.mockRejectedValue(
        new SidecarRpcError(-32001, "ENOENT: no such file or directory, open '/missing.txt'", {
          code: 'ENOENT',
          message: "ENOENT: no such file or directory, open '/missing.txt'",
          path: '/missing.txt',
        }),
      );

      await expect(readTextFile('/missing.txt')).rejects.toThrow("ENOENT: no such file or directory, open '/missing.txt'");
      expect(tauriMocks.readTextFile).not.toHaveBeenCalled();
    });

    it('surfaces a real fs error (EACCES) for writeTextFile without retrying locally', async () => {
      getSidecarStatusMock.mockReturnValue('running');
      requestMock.mockRejectedValue(
        new SidecarRpcError(-32001, 'EACCES: permission denied', {
          code: 'EACCES',
          message: 'EACCES: permission denied',
          path: '/protected.txt',
        }),
      );

      await expect(writeTextFile('/protected.txt', 'x')).rejects.toThrow('EACCES: permission denied');
      expect(tauriMocks.writeTextFile).not.toHaveBeenCalled();
    });
  });
});
