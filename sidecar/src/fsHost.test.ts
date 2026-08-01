import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { platform } from 'node:process';
import { RpcError } from './protocol';
import { fsReadTextFile, fsReadFile, fsWriteTextFile, fsReadDir, fsExists, fsStat } from './fsHost';

// Real node:fs against a real temp dir — no mocking. fsHost.ts's whole job is
// to faithfully wrap node:fs/promises, so exercising the real filesystem is
// the most direct way to prove the semantic-mapping claims in its module doc
// (readDir symlink semantics, stat following symlinks, error shapes).
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'abu-fshost-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('fsHost', () => {
  describe('param validation', () => {
    it.each([
      ['fs.readTextFile', fsReadTextFile],
      ['fs.readFile', fsReadFile],
      ['fs.readDir', fsReadDir],
      ['fs.exists', fsExists],
      ['fs.stat', fsStat],
    ])('%s rejects non-object params with RpcError -32602', async (_label, handler) => {
      await expect(handler(42)).rejects.toMatchObject({ code: -32602 });
      await expect((handler as (p: unknown) => Promise<unknown>)(undefined)).rejects.toMatchObject({ code: -32602 });
    });

    it.each([
      ['fs.readTextFile', fsReadTextFile],
      ['fs.readFile', fsReadFile],
      ['fs.readDir', fsReadDir],
      ['fs.exists', fsExists],
      ['fs.stat', fsStat],
    ])('%s rejects missing/empty path with RpcError -32602', async (_label, handler) => {
      await expect(handler({})).rejects.toMatchObject({ code: -32602 });
      await expect(handler({ path: '' })).rejects.toMatchObject({ code: -32602 });
      await expect(handler({ path: 123 })).rejects.toMatchObject({ code: -32602 });
    });

    it('fs.writeTextFile rejects missing path, missing contents, or wrong types', async () => {
      await expect(fsWriteTextFile(42)).rejects.toMatchObject({ code: -32602 });
      await expect(fsWriteTextFile({ path: '/x' })).rejects.toMatchObject({ code: -32602 });
      await expect(fsWriteTextFile({ path: '/x', contents: 5 })).rejects.toMatchObject({ code: -32602 });
      await expect(fsWriteTextFile({ path: '', contents: 'ok' })).rejects.toMatchObject({ code: -32602 });
    });

    it('errors thrown are RpcError instances (not plain objects)', async () => {
      await expect(fsReadTextFile({})).rejects.toBeInstanceOf(RpcError);
    });
  });

  describe('text roundtrip', () => {
    it('writes then reads back plain ASCII text', async () => {
      const file = path.join(tmpDir, 'plain.txt');
      const result = await fsWriteTextFile({ path: file, contents: 'hello world' });
      expect(result).toBeNull();
      const read = await fsReadTextFile({ path: file });
      expect(read).toBe('hello world');
    });

    it('roundtrips non-ASCII (CJK) and emoji content losslessly', async () => {
      const file = path.join(tmpDir, 'unicode.txt');
      const content = '你好，世界！🎉🚀 — emoji + CJK + em-dash';
      await fsWriteTextFile({ path: file, contents: content });
      const read = await fsReadTextFile({ path: file });
      expect(read).toBe(content);
    });

    it('writeTextFile create-or-truncates (matches plugin-fs default create:true semantics)', async () => {
      const file = path.join(tmpDir, 'truncate.txt');
      await fsWriteTextFile({ path: file, contents: 'this is a long first write' });
      await fsWriteTextFile({ path: file, contents: 'short' });
      const read = await fsReadTextFile({ path: file });
      expect(read).toBe('short'); // no leftover bytes from the longer first write
    });
  });

  describe('binary roundtrip (fs.readFile)', () => {
    it('returns base64 that decodes back to the exact original bytes, including non-UTF8-safe bytes', async () => {
      const file = path.join(tmpDir, 'binary.bin');
      const original = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80, 0x7f, ...Buffer.from('emoji 🎉 mixed in', 'utf-8')]);
      await fs.writeFile(file, original);

      const result = await fsReadFile({ path: file });
      expect(result).toHaveProperty('base64');
      const decoded = Buffer.from(result.base64, 'base64');
      expect(decoded.equals(original)).toBe(true);
    });
  });

  describe('fs.exists', () => {
    it('returns true for an existing file', async () => {
      const file = path.join(tmpDir, 'exists.txt');
      await fs.writeFile(file, 'x');
      await expect(fsExists({ path: file })).resolves.toBe(true);
    });

    it('returns false for a missing path (no throw)', async () => {
      await expect(fsExists({ path: path.join(tmpDir, 'nope.txt') })).resolves.toBe(false);
    });

    it('returns true for an existing directory', async () => {
      await expect(fsExists({ path: tmpDir })).resolves.toBe(true);
    });
  });

  describe('fs.stat', () => {
    it('reports isFile/size for a regular file', async () => {
      const file = path.join(tmpDir, 'sized.txt');
      await fs.writeFile(file, 'exactly17chars!!!');
      const result = await fsStat({ path: file });
      expect(result.isFile).toBe(true);
      expect(result.isDirectory).toBe(false);
      expect(result.isSymlink).toBe(false);
      expect(result.size).toBe(Buffer.byteLength('exactly17chars!!!'));
      expect(typeof result.mtimeMs).toBe('number');
    });

    it('reports isDirectory for a directory', async () => {
      const result = await fsStat({ path: tmpDir });
      expect(result.isDirectory).toBe(true);
      expect(result.isFile).toBe(false);
    });

    it('follows symlinks (isSymlink is always false — matches plugin-fs stat(), not lstat())', async () => {
      if (platform === 'win32') return; // symlinks need elevated perms on Windows CI runners
      const target = path.join(tmpDir, 'target.txt');
      await fs.writeFile(target, 'target contents');
      const link = path.join(tmpDir, 'link.txt');
      await fs.symlink(target, link);

      const result = await fsStat({ path: link });
      expect(result.isSymlink).toBe(false); // stat() resolves through the link
      expect(result.isFile).toBe(true); // reports the TARGET's type
      expect(result.size).toBe(Buffer.byteLength('target contents'));
    });

    it('rejects with RpcError -32001 and ENOENT data for a missing path', async () => {
      const missing = path.join(tmpDir, 'missing.txt');
      await expect(fsStat({ path: missing })).rejects.toMatchObject({
        code: -32001,
        data: { code: 'ENOENT', path: missing },
      });
    });
  });

  describe('fs.readDir', () => {
    it('lists files and subdirectories with correct isFile/isDirectory flags', async () => {
      await fs.writeFile(path.join(tmpDir, 'a.txt'), 'a');
      await fs.mkdir(path.join(tmpDir, 'subdir'));

      const entries = await fsReadDir({ path: tmpDir });
      const byName = new Map(entries.map((e) => [e.name, e]));

      expect(byName.get('a.txt')).toMatchObject({ isFile: true, isDirectory: false, isSymlink: false });
      expect(byName.get('subdir')).toMatchObject({ isFile: false, isDirectory: true, isSymlink: false });
    });

    it('reports a symlink entry as isSymlink:true, isFile:false, isDirectory:false (unfollowed — matches plugin-fs DirEntry)', async () => {
      if (platform === 'win32') return; // symlinks need elevated perms on Windows CI runners
      const target = path.join(tmpDir, 'real.txt');
      await fs.writeFile(target, 'x');
      await fs.symlink(target, path.join(tmpDir, 'sym.txt'));

      const entries = await fsReadDir({ path: tmpDir });
      const symEntry = entries.find((e) => e.name === 'sym.txt');
      expect(symEntry).toMatchObject({ isSymlink: true, isFile: false, isDirectory: false });
    });

    it('rejects with RpcError -32001 and ENOENT data for a missing directory', async () => {
      const missing = path.join(tmpDir, 'no-such-dir');
      await expect(fsReadDir({ path: missing })).rejects.toMatchObject({
        code: -32001,
        data: { code: 'ENOENT', path: missing },
      });
    });
  });

  describe('error mapping shape', () => {
    it('fs.readTextFile on a missing file rejects with RpcError carrying { code: ENOENT, message, path }', async () => {
      const missing = path.join(tmpDir, 'ghost.txt');
      await expect(fsReadTextFile({ path: missing })).rejects.toMatchObject({
        name: 'RpcError',
        code: -32001,
        data: { code: 'ENOENT', path: missing },
      });
    });

    it('fs.readTextFile on a directory rejects with an errno-mapped RpcError (EISDIR)', async () => {
      await expect(fsReadTextFile({ path: tmpDir })).rejects.toMatchObject({
        code: -32001,
        data: { code: 'EISDIR' },
      });
    });
  });
});
