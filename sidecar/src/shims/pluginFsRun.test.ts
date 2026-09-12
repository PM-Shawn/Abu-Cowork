import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile as nodeReadFile, rm, stat as nodeStat, writeFile as nodeWriteFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyFile, mkdir, remove, rename, writeFile, writeTextFile } from './pluginFsRun';

// The sidecar bundle swaps `@tauri-apps/plugin-fs` for this shim at build
// time, while TypeScript keeps checking every caller against the real
// plugin's types — so an option the shim ignores is dropped without a
// compile error. These cases pin the shim to the plugin's own semantics
// (tauri-plugin-fs 2.5.1 `write_file_inner` → Rust `std::fs::OpenOptions`).

const isWindows = process.platform === 'win32';

describe('sidecar plugin-fs shim', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'abu-plugin-fs-shim-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const read = (path: string) => nodeReadFile(path, 'utf-8');
  const missing = async (path: string) => {
    await expect(nodeStat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  };

  describe('writeTextFile', () => {
    it('creates or truncates when given no options, like the plugin default', async () => {
      const path = join(dir, 'a.txt');
      await writeTextFile(path, 'first, longer');
      await writeTextFile(path, 'second');
      expect(await read(path)).toBe('second');
    });

    describe('createNew', () => {
      it('creates a file that is not there yet', async () => {
        const path = join(dir, 'new.md');
        await writeTextFile(path, 'fresh', { createNew: true });
        expect(await read(path)).toBe('fresh');
      });

      it('refuses a file that already exists and leaves it untouched', async () => {
        const path = join(dir, 'AGENT.md');
        await nodeWriteFile(path, 'someone else wrote this');
        await expect(writeTextFile(path, 'mine', { createNew: true })).rejects.toMatchObject({ code: 'EEXIST' });
        expect(await read(path)).toBe('someone else wrote this');
      });

      it('wins over create: false, as in the plugin', async () => {
        const path = join(dir, 'both.md');
        await writeTextFile(path, 'fresh', { createNew: true, create: false });
        expect(await read(path)).toBe('fresh');
      });
    });

    describe('create: false', () => {
      it('refuses a file that is not there and does not create it', async () => {
        const path = join(dir, 'deleted-since-read.md');
        await expect(writeTextFile(path, 'roleId: x', { create: false })).rejects.toMatchObject({ code: 'ENOENT' });
        await missing(path);
      });

      it('overwrites a file that is there', async () => {
        const path = join(dir, 'AGENT.md');
        await nodeWriteFile(path, 'old content, longer');
        await writeTextFile(path, 'new', { create: false });
        expect(await read(path)).toBe('new');
      });
    });

    describe('append', () => {
      it('adds to the end of an existing file instead of overwriting it', async () => {
        const path = join(dir, 'today.log');
        await nodeWriteFile(path, 'line 1\n');
        await writeTextFile(path, 'line 2\n', { append: true });
        expect(await read(path)).toBe('line 1\nline 2\n');
      });

      it('creates the file when it is missing', async () => {
        const path = join(dir, 'today.log');
        await writeTextFile(path, 'line 1\n', { append: true });
        expect(await read(path)).toBe('line 1\n');
      });

      it('with create: false, refuses a missing file', async () => {
        const path = join(dir, 'today.log');
        await expect(writeTextFile(path, 'line', { append: true, create: false })).rejects.toMatchObject({ code: 'ENOENT' });
        await missing(path);
      });

      it('with create: false, adds to an existing file without truncating it', async () => {
        const path = join(dir, 'today.log');
        await nodeWriteFile(path, 'line 1\n');
        await writeTextFile(path, 'line 2\n', { append: true, create: false });
        expect(await read(path)).toBe('line 1\nline 2\n');
      });

      it('with createNew, refuses an existing file and leaves it untouched', async () => {
        const path = join(dir, 'today.log');
        await nodeWriteFile(path, 'line 1\n');
        await expect(writeTextFile(path, 'line 2\n', { append: true, createNew: true })).rejects.toMatchObject({ code: 'EEXIST' });
        expect(await read(path)).toBe('line 1\n');
      });
    });

    it.skipIf(isWindows)('creates the file with the requested mode', async () => {
      const path = join(dir, 'secret.json');
      await writeTextFile(path, '{}', { mode: 0o600 });
      expect((await nodeStat(path)).mode & 0o777).toBe(0o600);
    });

    // Bites only as a non-root user: honoring 0o400 would make the second
    // write fail with EACCES, which root bypasses.
    it('ignores mode on Windows, as the plugin does', async () => {
      const original = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'win32' });
      try {
        const path = join(dir, 'kept-writable.txt');
        await writeTextFile(path, 'first', { mode: 0o400 });
        await writeTextFile(path, 'second');
        expect(await read(path)).toBe('second');
      } finally {
        if (original) Object.defineProperty(process, 'platform', original);
      }
    });

    // A real baseDir caller passes a RELATIVE path; ignoring baseDir would
    // write it under the sidecar's cwd. Absolute paths keep any regression
    // inside the temp dir.
    it('rejects baseDir instead of writing a path relative to the sidecar', async () => {
      const path = join(dir, 'a.txt');
      await expect(writeTextFile(path, 'x', { baseDir: 14 })).rejects.toThrow(/baseDir/);
      await missing(path);
    });

    it('accepts options whose value is undefined', async () => {
      const path = join(dir, 'a.txt');
      await writeTextFile(path, 'x', { baseDir: undefined, createNew: undefined });
      expect(await read(path)).toBe('x');
    });
  });

  describe('writeFile', () => {
    const bytes = new TextEncoder().encode('png-bytes');

    it('refuses an existing file with createNew', async () => {
      const path = join(dir, 'image.png');
      await nodeWriteFile(path, 'kept');
      await expect(writeFile(path, bytes, { createNew: true })).rejects.toMatchObject({ code: 'EEXIST' });
      expect(await read(path)).toBe('kept');
    });

    it('refuses a missing file with create: false', async () => {
      const path = join(dir, 'image.png');
      await expect(writeFile(path, bytes, { create: false })).rejects.toMatchObject({ code: 'ENOENT' });
      await missing(path);
    });

    it('appends with append', async () => {
      const path = join(dir, 'blob.bin');
      await nodeWriteFile(path, 'head-');
      await writeFile(path, bytes, { append: true });
      expect(await read(path)).toBe('head-png-bytes');
    });

    it('rejects baseDir', async () => {
      const path = join(dir, 'image.png');
      await expect(writeFile(path, bytes, { baseDir: 14 })).rejects.toThrow(/baseDir/);
      await missing(path);
    });
  });

  describe('options the other side-effecting calls cannot honor', () => {
    it.skipIf(isWindows)('mkdir creates the directory with the requested mode', async () => {
      const path = join(dir, 'private');
      await mkdir(path, { mode: 0o700 });
      expect((await nodeStat(path)).mode & 0o777).toBe(0o700);
    });

    it('mkdir rejects baseDir', async () => {
      const path = join(dir, 'logs');
      await expect(mkdir(path, { recursive: true, baseDir: 14 })).rejects.toThrow(/baseDir/);
      await missing(path);
    });

    it('remove rejects baseDir and deletes nothing', async () => {
      const path = join(dir, 'keep.txt');
      await nodeWriteFile(path, 'kept');
      await expect(remove(path, { baseDir: 14 })).rejects.toThrow(/baseDir/);
      expect(await read(path)).toBe('kept');
    });

    it('copyFile rejects a per-path base directory', async () => {
      const from = join(dir, 'from.txt');
      await nodeWriteFile(from, 'x');
      await expect(copyFile(from, join(dir, 'to.txt'), { toPathBaseDir: 14 })).rejects.toThrow(/toPathBaseDir/);
      await missing(join(dir, 'to.txt'));
    });

    it('rename rejects a per-path base directory and moves nothing', async () => {
      const from = join(dir, 'from.txt');
      await nodeWriteFile(from, 'x');
      await expect(rename(from, join(dir, 'to.txt'), { oldPathBaseDir: 14 })).rejects.toThrow(/oldPathBaseDir/);
      expect(await read(from)).toBe('x');
    });
  });
});
