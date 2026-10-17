import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { exists, readTextFile, readFile, writeTextFile, mkdir, remove, stat, copyFile, rename, writeFile, readDir } from '@tauri-apps/plugin-fs';

const base64ToUint8ArrayMock = vi.hoisted(() => vi.fn());

vi.mock('@/utils/base64', async () => {
  const actual = await vi.importActual<typeof import('@/utils/base64')>('@/utils/base64');
  return {
    ...actual,
    base64ToUint8Array: base64ToUint8ArrayMock,
  };
});

// Extend the global plugin-fs mock with the symbols outputSnapshots needs
// (stat, copyFile, rename, writeFile are not in the default test setup mock).
vi.mock('@tauri-apps/plugin-fs', async () => {
  const actual = await vi.importActual<typeof import('@tauri-apps/plugin-fs')>('@tauri-apps/plugin-fs');
  return {
    ...actual,
    readTextFile: vi.fn(),
    readFile: vi.fn(),
    writeTextFile: vi.fn(),
    exists: vi.fn(),
    mkdir: vi.fn(),
    remove: vi.fn(),
    stat: vi.fn(),
    copyFile: vi.fn(),
    rename: vi.fn(),
    writeFile: vi.fn(),
    readDir: vi.fn(),
  };
});

// Imported lazily after mocks are configured
let mod: typeof import('./outputSnapshots');

// Filler mtime (TESTING.md §3) — the mock FS below needs some Date for its
// records' `mtime` field, but no test in this file asserts on the exact value.
const FIXED_MTIME = new Date(1_700_000_000_000);

// Helper: minimal in-memory FS that the snapshot module operates against
function createMemoryFs() {
  const files = new Map<string, { content: string; size: number; mtime: Date | null; isFile: boolean }>();
  const dirs = new Set<string>();

  const mockedExists = exists as ReturnType<typeof vi.fn>;
  const mockedReadText = readTextFile as ReturnType<typeof vi.fn>;
  const mockedWriteText = writeTextFile as ReturnType<typeof vi.fn>;
  const mockedMkdir = mkdir as ReturnType<typeof vi.fn>;
  const mockedRemove = remove as ReturnType<typeof vi.fn>;
  const mockedStat = stat as ReturnType<typeof vi.fn>;
  const mockedCopyFile = copyFile as ReturnType<typeof vi.fn>;
  const mockedRename = rename as ReturnType<typeof vi.fn>;

  mockedExists.mockImplementation(async (path: string) => {
    return files.has(path) || dirs.has(path);
  });

  mockedReadText.mockImplementation(async (path: string) => {
    if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
    return files.get(path)!.content;
  });

  (readFile as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
    if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
    return new TextEncoder().encode(files.get(path)!.content);
  });

  mockedWriteText.mockImplementation(async (path: string, content: string, options?: { append?: boolean }) => {
    const text = (options?.append ? files.get(path)?.content ?? '' : '') + content;
    files.set(path, { content: text, size: new TextEncoder().encode(text).byteLength, mtime: FIXED_MTIME, isFile: true });
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'));
    }
  });

  mockedMkdir.mockImplementation(async (path: string) => {
    dirs.add(path);
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'));
    }
  });

  mockedRemove.mockImplementation(async (path: string) => {
    for (const key of [...files.keys()]) {
      if (key === path || key.startsWith(path + '/')) files.delete(key);
    }
    for (const key of [...dirs]) {
      if (key === path || key.startsWith(path + '/')) dirs.delete(key);
    }
  });

  mockedStat.mockImplementation(async (path: string) => {
    const f = files.get(path);
    if (!f) throw new Error(`ENOENT: ${path}`);
    return {
      isFile: f.isFile,
      isDirectory: false,
      isSymlink: false,
      size: f.size,
      mtime: f.mtime,
      atime: null,
      birthtime: null,
    };
  });

  mockedCopyFile.mockImplementation(async (src: string, dest: string) => {
    const f = files.get(src);
    if (!f) throw new Error(`ENOENT: ${src}`);
    files.set(dest, { ...f });
    const parts = dest.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'));
    }
  });

  mockedRename.mockImplementation(async (src: string, dest: string) => {
    const f = files.get(src);
    if (!f) throw new Error(`ENOENT: ${src}`);
    files.set(dest, f);
    files.delete(src);
  });

  (readDir as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
    const names = new Map<string, boolean>();
    for (const dir of dirs) {
      if (dir.startsWith(`${path}/`) && !dir.slice(path.length + 1).includes('/')) names.set(dir.slice(path.length + 1), true);
    }
    for (const file of files.keys()) {
      if (file.startsWith(`${path}/`) && !file.slice(path.length + 1).includes('/')) names.set(file.slice(path.length + 1), false);
    }
    return [...names].map(([name, isDirectory]) => ({ name, isDirectory, isFile: !isDirectory, isSymlink: false }));
  });

  const mockedWriteFile = writeFile as ReturnType<typeof vi.fn>;
  mockedWriteFile.mockImplementation(async (path: string, bytes: Uint8Array) => {
    // Binary payload stored as a hex-y tag — these tests only need to
    // assert "a write happened with N bytes", not round-trip the content.
    files.set(path, { content: `[binary:${bytes.length}]`, size: bytes.length, mtime: FIXED_MTIME, isFile: true });
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'));
    }
  });

  return {
    files,
    dirs,
    copyFile: mockedCopyFile,
    writeFile: mockedWriteFile,
    /** Add a fake user file at the given absolute path */
    addUserFile(path: string, size = 100, content = 'x') {
      files.set(path, { content, size, mtime: new Date(2025, 0, 1), isFile: true });
    },
  };
}

const CONV_ID = 'conv_test_123';
const APP_DATA = '/Users/testuser/.abu';
const OUTPUTS_DIR = `${APP_DATA}/conversations/${CONV_ID}/outputs`;

describe('outputSnapshots', () => {
  let memFs: ReturnType<typeof createMemoryFs>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    base64ToUint8ArrayMock.mockReset();
    base64ToUint8ArrayMock.mockImplementation((base64: string) => {
      const binary = atob(base64);
      return Uint8Array.from(binary, (char) => char.charCodeAt(0));
    });
    memFs = createMemoryFs();
    mod = await import('./outputSnapshots');
    mod.__testing.resetCaches();
  });

  // ──────────────────────────────────────────────────────────────────
  describe('snapshotFile — happy path', () => {
    it('snapshots an absolute file and writes a manifest entry', async () => {
      memFs.addUserFile('/Users/testuser/Desktop/report.csv', 1024);

      const entry = await mod.snapshotFile(CONV_ID, '/Users/testuser/Desktop/report.csv', {
        source: 'tool-output',
        refId: 'toolu_001',
        refKind: 'write_file',
      });

      expect(entry).not.toBeNull();
      expect(entry!.basename).toBe('report.csv');
      expect(entry!.size).toBe(1024);
      expect(entry!.snapshotRelPath).toMatch(/^files\/.+\/report\.csv$/);
      expect(entry!.skipReason).toBeUndefined();
      expect(entry!.source).toBe('tool-output');
      expect(entry!.refId).toBe('toolu_001');
      expect(memFs.copyFile).toHaveBeenCalledOnce();
    });

    it('appends one record to the manifest log and never writes manifest.json', async () => {
      memFs.addUserFile('/Users/testuser/Desktop/a.txt', 50);
      await mod.snapshotFile(CONV_ID, '/Users/testuser/Desktop/a.txt', {
        source: 'tool-output',
        refId: 't1',
        refKind: 'write_file',
      });
      const log = memFs.files.get(`${OUTPUTS_DIR}/manifest-log.jsonl`)?.content ?? '';
      const records = log.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line));
      expect(records).toEqual([
        { op: 'set', entry: expect.objectContaining({ originalPath: '/Users/testuser/Desktop/a.txt', refId: 't1' }) },
      ]);
      expect(memFs.files.has(`${OUTPUTS_DIR}/manifest.json`)).toBe(false);
    });

    it('overwrites manifest entry on second snapshot of same path (latest version semantics)', async () => {
      memFs.addUserFile('/Users/testuser/Desktop/code.py', 100);
      await mod.snapshotFile(CONV_ID, '/Users/testuser/Desktop/code.py', {
        source: 'tool-output',
        refId: 'first',
        refKind: 'write_file',
      });

      memFs.addUserFile('/Users/testuser/Desktop/code.py', 200, 'updated content');
      const second = await mod.snapshotFile(CONV_ID, '/Users/testuser/Desktop/code.py', {
        source: 'tool-output',
        refId: 'second',
        refKind: 'edit_file',
      });

      expect(second!.size).toBe(200);
      expect(second!.refId).toBe('second');
      expect(second!.refKind).toBe('edit_file');

      const manifest = await mod.__testing.loadManifest(CONV_ID);
      expect(Object.keys(manifest.entries)).toHaveLength(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('snapshotFile — defensive guards', () => {
    it('returns null for empty path', async () => {
      const entry = await mod.snapshotFile(CONV_ID, '', { source: 'tool-output', refId: 'x', refKind: 'y' });
      expect(entry).toBeNull();
    });

    it('returns null for non-absolute path', async () => {
      const entry = await mod.snapshotFile(CONV_ID, 'relative/file.txt', {
        source: 'tool-output', refId: 'x', refKind: 'y',
      });
      expect(entry).toBeNull();
    });

    it('returns null when source file does not exist', async () => {
      const entry = await mod.snapshotFile(CONV_ID, '/nonexistent/file.txt', {
        source: 'tool-output', refId: 'x', refKind: 'y',
      });
      expect(entry).toBeNull();
    });

    it('expands ~/... before treating as absolute path', async () => {
      // homeDir mock returns /Users/testuser
      memFs.addUserFile('/Users/testuser/Desktop/Test/sample.csv', 500);

      const entry = await mod.snapshotFile(CONV_ID, '~/Desktop/Test/sample.csv', {
        source: 'tool-output', refId: 'tu_001', refKind: 'write_file',
      });

      expect(entry).not.toBeNull();
      expect(entry!.originalPath).toBe('/Users/testuser/Desktop/Test/sample.csv');
      expect(entry!.snapshotRelPath).toMatch(/^files\/.+\/sample\.csv$/);
      expect(memFs.copyFile).toHaveBeenCalled();
    });

    it('skips files already inside outputs/ (idempotency loop guard)', async () => {
      const innerPath = `${OUTPUTS_DIR}/files/aabbcc/inner.txt`;
      memFs.addUserFile(innerPath, 50);
      const entry = await mod.snapshotFile(CONV_ID, innerPath, {
        source: 'tool-output', refId: 'x', refKind: 'y',
      });
      expect(entry).toBeNull();
      expect(memFs.copyFile).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('snapshotFile — oversized', () => {
    it('records skipped entry with reason="oversized" for files over 5GB', async () => {
      // 5 GB + 1 byte
      const sixGB = mod.__testing.MAX_FILE_BYTES + 1;
      memFs.addUserFile('/Users/testuser/movies/big.mp4', sixGB);

      const entry = await mod.snapshotFile(CONV_ID, '/Users/testuser/movies/big.mp4', {
        source: 'tool-output', refId: 'tc1', refKind: 'run_command',
      });

      expect(entry).not.toBeNull();
      expect(entry!.snapshotRelPath).toBe('');
      expect(entry!.skipReason).toBe('oversized');
      expect(entry!.size).toBe(sixGB);
      expect(memFs.copyFile).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('snapshotFile — copy failure', () => {
    it('records skipped entry with reason="copy-failed" when copyFile throws', async () => {
      memFs.addUserFile('/Users/testuser/Desktop/x.csv', 100);
      memFs.copyFile.mockRejectedValueOnce(new Error('disk full'));

      const entry = await mod.snapshotFile(CONV_ID, '/Users/testuser/Desktop/x.csv', {
        source: 'tool-output', refId: 'tc1', refKind: 'write_file',
      });

      expect(entry).not.toBeNull();
      expect(entry!.snapshotRelPath).toBe('');
      expect(entry!.skipReason).toBe('copy-failed');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('resolveFileSource', () => {
    it('returns "available" with isFromSnapshot=false when original file exists', async () => {
      memFs.addUserFile('/Users/testuser/Desktop/live.csv', 100);
      const result = await mod.resolveFileSource(CONV_ID, '/Users/testuser/Desktop/live.csv');
      expect(result.status).toBe('available');
      if (result.status === 'available') {
        expect(result.path).toBe('/Users/testuser/Desktop/live.csv');
        expect(result.isFromSnapshot).toBe(false);
      }
    });

    it('falls back to snapshot when original is gone', async () => {
      memFs.addUserFile('/Users/testuser/Desktop/x.csv', 100);
      await mod.snapshotFile(CONV_ID, '/Users/testuser/Desktop/x.csv', {
        source: 'tool-output', refId: 'tc1', refKind: 'write_file',
      });
      // Remove original
      memFs.files.delete('/Users/testuser/Desktop/x.csv');

      const result = await mod.resolveFileSource(CONV_ID, '/Users/testuser/Desktop/x.csv');
      expect(result.status).toBe('available');
      if (result.status === 'available') {
        expect(result.isFromSnapshot).toBe(true);
        expect(result.path).toMatch(/outputs\/files\/.+\/x\.csv$/);
      }
    });

    it('returns "skipped" when manifest has oversized entry and original is gone', async () => {
      const sixGB = mod.__testing.MAX_FILE_BYTES + 1;
      memFs.addUserFile('/Users/testuser/movies/big.mp4', sixGB);
      await mod.snapshotFile(CONV_ID, '/Users/testuser/movies/big.mp4', {
        source: 'tool-output', refId: 'tc1', refKind: 'run_command',
      });
      memFs.files.delete('/Users/testuser/movies/big.mp4');

      const result = await mod.resolveFileSource(CONV_ID, '/Users/testuser/movies/big.mp4');
      expect(result.status).toBe('skipped');
      if (result.status === 'skipped') {
        expect(result.entry.skipReason).toBe('oversized');
      }
    });

    it('returns "missing" when no original and no manifest entry', async () => {
      const result = await mod.resolveFileSource(CONV_ID, '/Users/testuser/Desktop/never_existed.csv');
      expect(result.status).toBe('missing');
      if (result.status === 'missing') {
        expect(result.basename).toBe('never_existed.csv');
      }
    });

    it('returns "missing" when convId is undefined and original is gone', async () => {
      const result = await mod.resolveFileSource(undefined, '/Users/testuser/Desktop/x.csv');
      expect(result.status).toBe('missing');
    });

    it('probes session outputs/ when given a bare basename (AI wrote to outputDir)', async () => {
      // Simulate AI following the no-workspace prompt: it wrote the file directly
      // to the session output dir, then mentioned only the basename in chat text.
      const fileInOutputs = `${OUTPUTS_DIR}/业务分润体系指标诊断.pptx`;
      memFs.addUserFile(fileInOutputs, 80000);

      const result = await mod.resolveFileSource(CONV_ID, '业务分润体系指标诊断.pptx');
      expect(result.status).toBe('available');
      if (result.status === 'available') {
        expect(result.path).toBe(fileInOutputs);
        expect(result.isFromSnapshot).toBe(false);
      }
    });

    it('probes session outputs/ for relative paths too', async () => {
      const fileInOutputs = `${OUTPUTS_DIR}/report.csv`;
      memFs.addUserFile(fileInOutputs, 100);

      // Path comes in as "subdir/report.csv" or just "report.csv" — basename probe wins
      const result = await mod.resolveFileSource(CONV_ID, 'subdir/report.csv');
      expect(result.status).toBe('available');
      if (result.status === 'available') {
        expect(result.path).toBe(fileInOutputs);
      }
    });

    it('outputs probe does not fire when file is not in outputs dir', async () => {
      // Don't add the file anywhere
      const result = await mod.resolveFileSource(CONV_ID, 'mystery.csv');
      expect(result.status).toBe('missing');
    });

    it('expands ~/... to absolute home path before checking existence', async () => {
      // Mock home dir is /Users/testuser per test setup
      memFs.addUserFile('/Users/testuser/Library/Application Support/com.abu.app/conversations/conv_test_123/outputs/x.pptx', 1000);

      const result = await mod.resolveFileSource(
        CONV_ID,
        '~/Library/Application Support/com.abu.app/conversations/conv_test_123/outputs/x.pptx',
      );
      expect(result.status).toBe('available');
      if (result.status === 'available') {
        expect(result.path).toBe(
          '/Users/testuser/Library/Application Support/com.abu.app/conversations/conv_test_123/outputs/x.pptx',
        );
      }
    });

    it('expanded ~/... still falls through to outputs probe by basename', async () => {
      // The ~ path doesn't actually exist, but the file is in outputs dir
      memFs.addUserFile(`${OUTPUTS_DIR}/business-report.pptx`, 5000);

      const result = await mod.resolveFileSource(
        CONV_ID,
        '~/Desktop/business-report.pptx',  // wrong location, but basename matches outputs entry
      );
      expect(result.status).toBe('available');
      if (result.status === 'available') {
        expect(result.path).toBe(`${OUTPUTS_DIR}/business-report.pptx`);
      }
    });

    it('falls back to manifest basename match when bare basename is given', async () => {
      // Code-block save scenario: file is at user's chosen location, snapshot is in
      // outputs/files/{hash}/, AI text mentions only the bare basename.
      memFs.addUserFile('/Users/testuser/Desktop/Test/sample_data.csv', 1000);
      await mod.snapshotCodeBlockSave(CONV_ID, '/Users/testuser/Desktop/Test/sample_data.csv', 'csv');
      // User deletes the original
      memFs.files.delete('/Users/testuser/Desktop/Test/sample_data.csv');

      // Lookup with just the basename (as text-extraction would yield)
      const result = await mod.resolveFileSource(CONV_ID, 'sample_data.csv');
      expect(result.status).toBe('available');
      if (result.status === 'available') {
        expect(result.isFromSnapshot).toBe(true);
        expect(result.path).toMatch(/outputs\/files\/.+\/sample_data\.csv$/);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('snapshotToolOutputs', () => {
    it('snapshots files extracted from a write_file tool call', async () => {
      memFs.addUserFile('/Users/testuser/Desktop/output.csv', 200);

      await mod.snapshotToolOutputs(CONV_ID, {
        id: 'toolu_xyz',
        name: 'write_file',
        input: { path: '/Users/testuser/Desktop/output.csv', content: 'data' },
        result: 'Successfully wrote 4 characters to /Users/testuser/Desktop/output.csv',
      });

      const manifest = await mod.__testing.loadManifest(CONV_ID);
      expect(Object.keys(manifest.entries)).toContain('/Users/testuser/Desktop/output.csv');
    });

    it('does nothing when extractFileOutputs returns no targets', async () => {
      await mod.snapshotToolOutputs(CONV_ID, {
        id: 'toolu_x',
        name: 'web_search',
        input: { query: 'something' },
        result: 'no files here',
      });
      const manifest = await mod.__testing.loadManifest(CONV_ID);
      expect(Object.keys(manifest.entries)).toHaveLength(0);
    });
  });

  describe('snapshotResultImage', () => {
    it('copies a read_file image and records it as a result-image manifest entry', async () => {
      const sourcePath = '/Users/testuser/Desktop/chart.png';
      memFs.addUserFile(sourcePath, 256);

      await mod.snapshotResultImage(CONV_ID, 'toolu_read', {
        mediaType: 'image/png',
        base64: 'aWdub3JlZA==',
      }, sourcePath);

      const manifest = await mod.__testing.loadManifest(CONV_ID);
      const entry = manifest.entries['tool-result://toolu_read'];
      expect(entry).toMatchObject({
        source: 'tool-output',
        refKind: 'result-image',
        refId: 'toolu_read',
        basename: 'result.png',
        snapshotRelPath: expect.stringMatching(/^files\/.+\/result\.png$/),
      });
      expect(memFs.copyFile).toHaveBeenCalledWith(sourcePath, expect.stringMatching(/result\.png$/));
    });

    it('writes base64 screenshot bytes and records the manifest entry', async () => {
      await mod.snapshotResultImage(CONV_ID, 'toolu_screen', {
        mediaType: 'image/png',
        base64: 'AQID',
      });

      expect(memFs.writeFile).toHaveBeenCalledWith(
        expect.stringMatching(/files\/.+\/result\.png$/),
        expect.any(Uint8Array),
      );
      const manifest = await mod.__testing.loadManifest(CONV_ID);
      expect(manifest.entries['tool-result://toolu_screen']).toMatchObject({
        source: 'tool-output',
        refKind: 'result-image',
        refId: 'toolu_screen',
        basename: 'result.png',
        size: 3,
      });
    });

    it('materializes base64 under a stable manifest identity when the read_file source path is relative', async () => {
      await mod.snapshotResultImage(CONV_ID, 'toolu_relative', {
        mediaType: 'image/png',
        base64: 'AQID',
      }, 'assets/chart.png');

      expect(memFs.copyFile).not.toHaveBeenCalled();
      expect(memFs.writeFile).toHaveBeenCalledWith(
        expect.stringMatching(/files\/.+\/result\.png$/),
        expect.any(Uint8Array),
      );

      const manifest = await mod.__testing.loadManifest(CONV_ID);
      const entry = manifest.entries['tool-result://toolu_relative'];
      expect(entry).toMatchObject({
        source: 'tool-output',
        refKind: 'result-image',
        refId: 'toolu_relative',
        basename: 'result.png',
        snapshotRelPath: expect.stringMatching(/^files\/.+\/result\.png$/),
        size: 3,
      });
    });

    it('records an oversized base64 result without writing its bytes', async () => {
      const oversized = mod.__testing.MAX_FILE_BYTES + 1;
      base64ToUint8ArrayMock.mockReturnValueOnce({ byteLength: oversized } as Uint8Array);

      await mod.snapshotResultImage(CONV_ID, 'toolu_oversized', {
        mediaType: 'image/png',
        base64: 'AQID',
      });

      expect(memFs.writeFile).not.toHaveBeenCalled();
      const manifest = await mod.__testing.loadManifest(CONV_ID);
      expect(manifest.entries['tool-result://toolu_oversized']).toMatchObject({
        basename: 'result.png',
        size: oversized,
        snapshotRelPath: '',
        skipReason: 'oversized',
      });
    });

    it('records write-failed when decoded result bytes cannot be persisted', async () => {
      memFs.writeFile.mockRejectedValueOnce(new Error('disk unavailable'));

      await mod.snapshotResultImage(CONV_ID, 'toolu_write_failed', {
        mediaType: 'image/png',
        base64: 'AQID',
      });

      const manifest = await mod.__testing.loadManifest(CONV_ID);
      expect(manifest.entries['tool-result://toolu_write_failed']).toMatchObject({
        basename: 'result.png',
        size: 3,
        snapshotRelPath: '',
        skipReason: 'write-failed',
      });
    });

    it('records write-failed when result base64 decoding fails', async () => {
      base64ToUint8ArrayMock.mockImplementationOnce(() => {
        throw new Error('invalid base64');
      });

      await mod.snapshotResultImage(CONV_ID, 'toolu_decode_failed', {
        mediaType: 'image/png',
        base64: 'not-base64',
      });

      expect(memFs.writeFile).not.toHaveBeenCalled();
      const manifest = await mod.__testing.loadManifest(CONV_ID);
      expect(manifest.entries['tool-result://toolu_decode_failed']).toMatchObject({
        basename: 'result.png',
        size: 0,
        snapshotRelPath: '',
        skipReason: 'write-failed',
      });
    });

    it('skips a repeated toolCallId without writing the image twice', async () => {
      const image = { mediaType: 'image/png', base64: 'AQID' };
      await mod.snapshotResultImage(CONV_ID, 'toolu_once', image);
      await mod.snapshotResultImage(CONV_ID, 'toolu_once', image);

      expect(memFs.writeFile).toHaveBeenCalledOnce();
      const manifest = await mod.__testing.loadManifest(CONV_ID);
      expect(Object.values(manifest.entries)).toHaveLength(1);
    });

    it('keeps separate identities when different tool calls read the same changing path', async () => {
      const sourcePath = '/Users/testuser/Desktop/chart.png';
      memFs.addUserFile(sourcePath, 100);
      await mod.snapshotResultImage(CONV_ID, 'toolu_first', {
        mediaType: 'image/png',
        base64: 'AQID',
      }, sourcePath);

      memFs.addUserFile(sourcePath, 200);
      await mod.snapshotResultImage(CONV_ID, 'toolu_second', {
        mediaType: 'image/png',
        base64: 'BAUG',
      }, sourcePath);

      const manifest = await mod.__testing.loadManifest(CONV_ID);
      const first = manifest.entries['tool-result://toolu_first'];
      const second = manifest.entries['tool-result://toolu_second'];
      expect(first).toMatchObject({ refId: 'toolu_first', size: 100 });
      expect(second).toMatchObject({ refId: 'toolu_second', size: 200 });
      expect(first.snapshotRelPath).not.toBe(second.snapshotRelPath);
      expect(memFs.copyFile.mock.calls[0][1]).not.toBe(memFs.copyFile.mock.calls[1][1]);
    });

    it.each([
      '../../../../../../Documents/owned',
      '..\\..\\escape',
      'nested/id',
    ])('never uses provider toolCallId %s as a filesystem segment', async (toolCallId) => {
      await mod.snapshotResultImage(CONV_ID, toolCallId, {
        mediaType: 'image/png',
        base64: 'AQID',
      });

      const target = memFs.writeFile.mock.calls[0][0] as string;
      expect(target).toMatch(new RegExp(`^${OUTPUTS_DIR}/files/[^/]+/result\\.png$`));
      expect(target).not.toContain('..');
      expect(target).not.toContain(toolCallId);
    });

    it.each([
      ['image/bmp', 'bmp'],
      ['image/svg+xml', 'svg'],
      ['image/x-icon', 'ico'],
    ])('preserves the %s payload extension', async (mediaType, extension) => {
      await mod.snapshotResultImage(CONV_ID, `toolu_${extension}`, {
        mediaType,
        base64: 'AQID',
      });

      expect(memFs.writeFile).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`/result\\.${extension}$`)),
        expect.any(Uint8Array),
      );
      const manifest = await mod.__testing.loadManifest(CONV_ID);
      expect(manifest.entries[`tool-result://toolu_${extension}`]?.basename).toBe(`result.${extension}`);
    });

    it('does not write an unsupported image MIME type under a false extension', async () => {
      await mod.snapshotResultImage(CONV_ID, 'toolu_unknown', {
        mediaType: 'image/x-unknown',
        base64: 'AQID',
      });

      expect(memFs.writeFile).not.toHaveBeenCalled();
      const manifest = await mod.__testing.loadManifest(CONV_ID);
      expect(Object.values(manifest.entries)).toHaveLength(0);
    });

    it('resolves an outputRef relative path exactly from outputs', async () => {
      await mod.snapshotResultImage(CONV_ID, 'toolu_screen', {
        mediaType: 'image/png',
        base64: 'AQID',
      });
      const entry = mod.findToolResultImageSnapshot(CONV_ID, 'toolu_screen');
      expect(entry?.snapshotRelPath).toMatch(/^files\/.+\/result\.png$/);

      const resolved = await mod.resolveOutputRefSource(CONV_ID, entry!.snapshotRelPath);

      expect(resolved).toEqual({
        status: 'available',
        path: `${OUTPUTS_DIR}/${entry!.snapshotRelPath}`,
        isFromSnapshot: true,
      });
    });

    it('rejects outputRef paths that escape outputs', async () => {
      const resolved = await mod.resolveOutputRefSource(CONV_ID, 'files/hash/../secret.png');
      expect(resolved.status).toBe('missing');
    });

    it('only exposes successful result-image snapshots to the dehydration guard', async () => {
      mod.__testing.setManifest(CONV_ID, {
        version: 1,
        entries: {
          'tool-result://toolu_ok': {
            originalPath: 'tool-result://toolu_ok',
            basename: 'result.png',
            snapshotRelPath: 'files/hash/result.png',
            size: 3,
            originalMtime: 0,
            snapshottedAt: 1_700_000_000_000,
            source: 'tool-output',
            refId: 'toolu_ok',
            refKind: 'result-image',
          },
          'tool-result://toolu_skipped': {
            originalPath: 'tool-result://toolu_skipped',
            basename: 'result.png',
            snapshotRelPath: '',
            size: 3,
            originalMtime: 0,
            snapshottedAt: 1_700_000_000_000,
            source: 'tool-output',
            refId: 'toolu_skipped',
            refKind: 'result-image',
            skipReason: 'write-failed',
          },
        },
      });

      expect(mod.findToolResultImageSnapshot(CONV_ID, 'toolu_ok')?.snapshotRelPath).toBe('files/hash/result.png');
      expect(mod.findToolResultImageSnapshot(CONV_ID, 'toolu_skipped')).toBeNull();
      expect(mod.findToolResultImageSnapshot(CONV_ID, 'toolu_missing')).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('snapshotUserUpload', () => {
    it('snapshots an uploaded image with source="user-upload"', async () => {
      memFs.addUserFile('/Users/testuser/Pictures/photo.png', 5000);

      await mod.snapshotUserUpload(CONV_ID, '/Users/testuser/Pictures/photo.png', 'msg_001', 'image');

      const manifest = await mod.__testing.loadManifest(CONV_ID);
      const entry = manifest.entries['/Users/testuser/Pictures/photo.png'];
      expect(entry).toBeDefined();
      expect(entry.source).toBe('user-upload');
      expect(entry.refId).toBe('msg_001');
      expect(entry.refKind).toBe('image');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('cleanupConversationOutputs', () => {
    it('clears the in-memory manifest cache', async () => {
      memFs.addUserFile('/Users/testuser/Desktop/x.csv', 100);
      await mod.snapshotFile(CONV_ID, '/Users/testuser/Desktop/x.csv', {
        source: 'tool-output', refId: 't1', refKind: 'write_file',
      });

      // Manifest is cached now
      let manifest = await mod.__testing.loadManifest(CONV_ID);
      expect(Object.keys(manifest.entries)).toHaveLength(1);

      // Cleanup wipes both disk and cache
      await mod.cleanupConversationOutputs(CONV_ID);

      // After cleanup, loadManifest returns a fresh empty manifest
      manifest = await mod.__testing.loadManifest(CONV_ID);
      expect(Object.keys(manifest.entries)).toHaveLength(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('manifest cache', () => {
    it('serves repeated reads from cache without re-reading disk', async () => {
      memFs.addUserFile('/Users/testuser/Desktop/x.csv', 100);
      await mod.snapshotFile(CONV_ID, '/Users/testuser/Desktop/x.csv', {
        source: 'tool-output', refId: 't1', refKind: 'write_file',
      });

      // Reset readTextFile call count after the snapshot operation
      (readTextFile as ReturnType<typeof vi.fn>).mockClear();

      // Multiple resolves should hit cache
      await mod.resolveFileSource(CONV_ID, '/Users/testuser/Desktop/x.csv');
      await mod.resolveFileSource(CONV_ID, '/Users/testuser/Desktop/x.csv');
      await mod.resolveFileSource(CONV_ID, '/Users/testuser/Desktop/x.csv');

      // Cache hit means readTextFile should NOT be called for manifest reads
      // (it may still be called for other reasons but for this test we expect 0)
      expect(readTextFile).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('manifest corruption fall back', () => {
    it('falls back to empty manifest when manifest.json is invalid JSON', async () => {
      // Manually plant a corrupt manifest file
      memFs.files.set(`${OUTPUTS_DIR}/manifest.json`, {
        content: '{ corrupted',
        size: 11,
        mtime: FIXED_MTIME,
        isFile: true,
      });

      const manifest = await mod.__testing.loadManifest(CONV_ID);
      expect(manifest.version).toBe(1);
      expect(manifest.entries).toEqual({});
    });

    it('falls back to empty manifest when version mismatches', async () => {
      memFs.files.set(`${OUTPUTS_DIR}/manifest.json`, {
        content: JSON.stringify({ version: 999, entries: { foo: { originalPath: 'foo' } } }),
        size: 50,
        mtime: FIXED_MTIME,
        isFile: true,
      });

      const manifest = await mod.__testing.loadManifest(CONV_ID);
      expect(Object.keys(manifest.entries)).toHaveLength(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('installSharedAttachments — share import path', () => {
    // Helpers
    function makeAttachment(over: Partial<import('./outputSnapshots').ShareAttachmentInput> = {}): import('./outputSnapshots').ShareAttachmentInput {
      return {
        basename: 'report.xlsx',
        originalPath: '~/Desktop/报表/report.xlsx',
        source: 'tool-output',
        sizeBytes: 3,
        data: btoa('abc'),
        ...over,
      };
    }

    it('writes the binary payload and registers a manifest entry with shared-import metadata', async () => {
      const result = await mod.installSharedAttachments(CONV_ID, {
        key1: makeAttachment(),
      });

      expect(result.installed).toBe(1);
      expect(result.skipped).toBe(0);

      // Manifest should carry the new entry, keyed by expanded+normalized path
      const manifest = await mod.__testing.loadManifest(CONV_ID);
      const entries = Object.values(manifest.entries);
      expect(entries).toHaveLength(1);
      const e = entries[0];
      expect(e.originalPath).toBe('/Users/testuser/Desktop/报表/report.xlsx');
      expect(e.basename).toBe('report.xlsx');
      expect(e.source).toBe('tool-output');
      expect(e.refId).toBe('shared-import');
      expect(e.refKind).toBe('shared');
      expect(e.snapshotRelPath).toMatch(/^files\/.+\/report\.xlsx$/);
      // The underlying file was actually written to disk (mocked FS)
      const writtenPath = `${OUTPUTS_DIR}/${e.snapshotRelPath}`;
      expect(memFs.files.has(writtenPath)).toBe(true);
      expect(memFs.files.get(writtenPath)!.size).toBe(3);
    });

    it('skips entries without a base64 payload (user-upload-excluded / oversized / missing)', async () => {
      const result = await mod.installSharedAttachments(CONV_ID, {
        a: makeAttachment({ basename: 'a.xlsx', data: undefined }),
        b: makeAttachment({ basename: 'b.xlsx', data: btoa('hi') }),
      });

      expect(result.installed).toBe(1);
      expect(result.skipped).toBe(1);
      const manifest = await mod.__testing.loadManifest(CONV_ID);
      expect(Object.keys(manifest.entries)).toHaveLength(1);
    });

    it('preserves source kind (tool-output / code-save)', async () => {
      await mod.installSharedAttachments(CONV_ID, {
        tool: makeAttachment({ basename: 'tool.xlsx', originalPath: '~/tool.xlsx', source: 'tool-output' }),
        code: makeAttachment({ basename: 'code.py', originalPath: '~/code.py', source: 'code-save' }),
      });

      const manifest = await mod.__testing.loadManifest(CONV_ID);
      const sources = Object.values(manifest.entries).map((e) => e.source).sort();
      expect(sources).toEqual(['code-save', 'tool-output']);
    });

    it('counts malformed base64 as a skipped entry without aborting the batch', async () => {
      const result = await mod.installSharedAttachments(CONV_ID, {
        good: makeAttachment({ basename: 'good.xlsx', originalPath: '~/good.xlsx' }),
        bad: makeAttachment({ basename: 'bad.xlsx', originalPath: '~/bad.xlsx', data: '!!!not base64!!!' }),
      });

      expect(result.installed).toBe(1);
      expect(result.skipped).toBe(1);
    });

    it('handles an empty attachments map as a zero-install, zero-skip no-op', async () => {
      const result = await mod.installSharedAttachments(CONV_ID, {});
      expect(result).toEqual({ installed: 0, skipped: 0 });
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('copy limits', () => {
    const MB = 1024 * 1024;
    const DESKTOP = '/Users/testuser/Desktop';

    let secondsElapsed = 0;

    beforeEach(() => {
      secondsElapsed = 0;
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(FIXED_MTIME);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Snapshot a file of `size` bytes one second after the previous one. */
    async function keep(name: string, size: number, convId = CONV_ID) {
      secondsElapsed += 1;
      vi.setSystemTime(FIXED_MTIME.getTime() + secondsElapsed * 1000);
      memFs.addUserFile(`${DESKTOP}/${name}`, size);
      return mod.snapshotFile(convId, `${DESKTOP}/${name}`, { source: 'tool-output', refId: name, refKind: 'write_file' });
    }

    async function keptNames(convId = CONV_ID): Promise<string[]> {
      return Object.values((await mod.__testing.loadManifest(convId)).entries).map((e) => e.basename).sort();
    }

    function copyExists(entry: { snapshotRelPath: string } | null, convId = CONV_ID): boolean {
      return memFs.files.has(`${APP_DATA}/conversations/${convId}/outputs/${entry?.snapshotRelPath}`);
    }

    it('copies a file of 200 MB and records a larger one as oversized', async () => {
      const atLimit = await keep('at-limit.mov', 200 * MB);
      const over = await keep('over.mov', 200 * MB + 1);
      expect(atLimit?.snapshotRelPath).not.toBe('');
      expect(over).toMatchObject({ snapshotRelPath: '', skipReason: 'oversized' });
    });

    it('evicts the oldest copy once a conversation holds more than 1 GB', async () => {
      const first = await keep('first.mov', 200 * MB);
      for (const name of ['b.mov', 'c.mov', 'd.mov', 'e.mov']) await keep(name, 200 * MB);
      expect(copyExists(first)).toBe(true);

      await keep('f.mov', 200 * MB);

      expect(await keptNames()).toEqual(['b.mov', 'c.mov', 'd.mov', 'e.mov', 'f.mov']);
      expect(copyExists(first)).toBe(false);
    });

    it('evicts a copy whose original is still in place before the only remaining copy of a moved file', async () => {
      const moved = await keep('moved.mov', 200 * MB);
      const inPlace = await keep('in-place.mov', 200 * MB);
      for (const name of ['x.mov', 'y.mov', 'z.mov']) await keep(name, 200 * MB);
      memFs.files.delete(`${DESKTOP}/moved.mov`);

      await keep('new.mov', 200 * MB);

      expect(await keptNames()).toEqual(['moved.mov', 'new.mov', 'x.mov', 'y.mov', 'z.mov']);
      expect(copyExists(moved)).toBe(true);
      expect(copyExists(inPlace)).toBe(false);
    });

    it('treats an original that changed since the copy as gone', async () => {
      await keep('edited.mov', 200 * MB);
      await keep('untouched.mov', 200 * MB);
      for (const name of ['x.mov', 'y.mov', 'z.mov']) await keep(name, 200 * MB);
      memFs.addUserFile(`${DESKTOP}/edited.mov`, 199 * MB);

      await keep('new.mov', 200 * MB);

      expect(await keptNames()).toEqual(['edited.mov', 'new.mov', 'x.mov', 'y.mov', 'z.mov']);
    });

    it('never evicts the copy it has just written', async () => {
      for (const name of ['b.mov', 'c.mov', 'd.mov', 'e.mov', 'f.mov']) {
        await keep(name, 200 * MB);
        memFs.files.delete(`${DESKTOP}/${name}`);
      }

      // The new copy is the only one whose original is in place, so it would
      // rank first for eviction were it a candidate.
      const kept = await keep('new.mov', 200 * MB);

      expect(copyExists(kept)).toBe(true);
      expect(await keptNames()).toEqual(['c.mov', 'd.mov', 'e.mov', 'f.mov', 'new.mov']);
    });

    it('neither counts nor evicts tool-result images and shared attachments', async () => {
      const base64 = btoa('x');
      memFs.addUserFile(`${DESKTOP}/shot.png`, 150 * MB);
      await mod.snapshotResultImage(CONV_ID, 'toolu_1', { type: 'image', mediaType: 'image/png', base64 }, `${DESKTOP}/shot.png`);
      await mod.installSharedAttachments(CONV_ID, {
        shared: { basename: 'shared.pdf', originalPath: '/elsewhere/shared.pdf', source: 'tool-output', sizeBytes: 900 * MB, data: base64 },
      });

      for (const name of ['a.mov', 'b.mov', 'c.mov', 'd.mov', 'e.mov']) await keep(name, 200 * MB);

      expect(await keptNames()).toEqual(['a.mov', 'b.mov', 'c.mov', 'd.mov', 'e.mov', 'result.png', 'shared.pdf']);
    });

    it('leaves the file when the other process records a newer copy of the same path during the eviction', async () => {
      const first = await keep('first.mov', 200 * MB);
      for (const name of ['b.mov', 'c.mov', 'd.mov', 'e.mov']) await keep(name, 200 * MB);
      const logFile = `${OUTPUTS_DIR}/manifest-log.jsonl`;
      const write = writeTextFile as ReturnType<typeof vi.fn>;
      const appendOwn = write.getMockImplementation()!;
      write.mockImplementation(async (path: string, content: string, options?: { append?: boolean }) => {
        await appendOwn(path, content, options);
        if (path === logFile && content.includes('"op":"remove"')) {
          // The other process copied first.mov again onto the same file and recorded it.
          const newer = { ...first!, snapshottedAt: first!.snapshottedAt + 500, refId: 'again' };
          await appendOwn(path, `\n${JSON.stringify({ op: 'set', entry: newer })}\n`, { append: true });
        }
      });

      await keep('f.mov', 200 * MB);

      expect(copyExists(first)).toBe(true);
      expect((await mod.__testing.loadManifest(CONV_ID)).entries[first!.originalPath].refId).toBe('again');
    });

    it('neither counts nor evicts an entry whose size is not a byte count', async () => {
      const broken = await keep('broken.mov', 200 * MB);
      await mod.__testing.refreshOutputManifest(CONV_ID);
      const logFile = `${OUTPUTS_DIR}/manifest-log.jsonl`;
      const sizeless = { ...broken!, size: undefined };
      memFs.files.get(logFile)!.content += `\n${JSON.stringify({ op: 'set', entry: sizeless })}\n`;

      for (const name of ['b.mov', 'c.mov', 'd.mov', 'e.mov', 'f.mov']) await keep(name, 200 * MB);

      // The other five hold 1000 MB, under the limit: a NaN total would have evicted them all.
      expect(await keptNames()).toEqual(['b.mov', 'broken.mov', 'c.mov', 'd.mov', 'e.mov', 'f.mov']);
      expect(copyExists(broken)).toBe(true);
    });

    describe('an original that cannot be read', () => {
      /** Make reading the given originals fail with `error`; every other path reads as before. */
      function failReading(names: string[], error: () => Error) {
        const read = stat as ReturnType<typeof vi.fn>;
        const fromDisk = read.getMockImplementation()!;
        read.mockImplementation(async (path: string) => {
          if (names.some((name) => path === `${DESKTOP}/${name}`)) throw error();
          return fromDisk(path);
        });
      }

      function withCode(message: string, code: string): Error {
        return Object.assign(new Error(message), { code });
      }

      it('keeps the copy and evicts the others in order', async () => {
        const unreadable = await keep('a.mov', 200 * MB);
        for (const name of ['b.mov', 'c.mov', 'd.mov', 'e.mov']) await keep(name, 200 * MB);
        failReading(['a.mov'], () => withCode('EACCES: permission denied', 'EACCES'));

        await keep('f.mov', 200 * MB);

        expect(await keptNames()).toEqual(['a.mov', 'c.mov', 'd.mov', 'e.mov', 'f.mov']);
        expect(copyExists(unreadable)).toBe(true);
      });

      it('keeps the copy when the path of an unreadable original holds words of a missing file', async () => {
        const folder = `${DESKTOP}/404 Not Found 排查`;
        vi.setSystemTime(FIXED_MTIME.getTime() + 500);
        memFs.addUserFile(`${folder}/a.mov`, 200 * MB);
        const unreadable = await mod.snapshotFile(CONV_ID, `${folder}/a.mov`, { source: 'tool-output', refId: 'a', refKind: 'write_file' });
        for (const name of ['b.mov', 'c.mov', 'd.mov', 'e.mov']) {
          await keep(name, 200 * MB);
          memFs.files.delete(`${DESKTOP}/${name}`);
        }
        const read = stat as ReturnType<typeof vi.fn>;
        const fromDisk = read.getMockImplementation()!;
        read.mockImplementation(async (path: string) => {
          if (path === `${folder}/a.mov`) {
            throw new Error(`Error invoking remote method 'tauri:invoke': Error: EACCES: permission denied, stat '${path}'`);
          }
          return fromDisk(path);
        });

        await keep('f.mov', 200 * MB);

        expect(copyExists(unreadable)).toBe(true);
        expect(await keptNames()).toEqual(['a.mov', 'c.mov', 'd.mov', 'e.mov', 'f.mov']);
      });

      it('evicts nothing when no original can be read', async () => {
        for (const name of ['a.mov', 'b.mov', 'c.mov', 'd.mov', 'e.mov']) await keep(name, 200 * MB);
        failReading(['a.mov', 'b.mov', 'c.mov', 'd.mov', 'e.mov'], () => withCode('EIO: i/o error', 'EIO'));

        await keep('f.mov', 200 * MB);

        expect(await keptNames()).toEqual(['a.mov', 'b.mov', 'c.mov', 'd.mov', 'e.mov', 'f.mov']);
      });

      it('treats a missing-file error that lost its code on the way as gone', async () => {
        const gone = await keep('a.mov', 200 * MB);
        for (const name of ['b.mov', 'c.mov', 'd.mov', 'e.mov']) await keep(name, 200 * MB);
        failReading(['b.mov', 'c.mov', 'd.mov', 'e.mov'], () => withCode('EACCES: permission denied', 'EACCES'));
        failReading(['a.mov'], () => new Error("Error invoking remote method 'tauri:invoke': no such file or directory"));

        await keep('f.mov', 200 * MB);

        expect(await keptNames()).toEqual(['b.mov', 'c.mov', 'd.mov', 'e.mov', 'f.mov']);
        expect(copyExists(gone)).toBe(false);
      });

      it('treats a path whose folder became a file as gone', async () => {
        await keep('a.mov', 200 * MB);
        for (const name of ['b.mov', 'c.mov', 'd.mov', 'e.mov']) await keep(name, 200 * MB);
        failReading(['b.mov', 'c.mov', 'd.mov', 'e.mov'], () => withCode('EACCES: permission denied', 'EACCES'));
        failReading(['a.mov'], () => withCode('ENOTDIR: not a directory', 'ENOTDIR'));

        await keep('f.mov', 200 * MB);

        expect(await keptNames()).toEqual(['b.mov', 'c.mov', 'd.mov', 'e.mov', 'f.mov']);
      });
    });

    it('keeps an evicted entry gone for a process that reads the log afresh', async () => {
      for (const name of ['a.mov', 'b.mov', 'c.mov', 'd.mov', 'e.mov', 'f.mov']) await keep(name, 200 * MB);

      mod.__testing.resetCaches();

      expect(await keptNames()).toEqual(['b.mov', 'c.mov', 'd.mov', 'e.mov', 'f.mov']);
    });

    describe('enforceTotalCopyLimit', () => {
      const OTHER = 'conv_other';

      /** Copies taken before the limits existed, as a 1 GB-per-file legacy manifest. */
      function seedLegacy(convId: string, names: string[], snapshottedAtStart: number) {
        const outputs = `${APP_DATA}/conversations/${convId}/outputs`;
        const entries: Record<string, unknown> = {};
        names.forEach((name, i) => {
          const originalPath = `${DESKTOP}/${convId}-${name}`;
          memFs.addUserFile(originalPath, 1024 * MB);
          const snapshotRelPath = `files/${name}/${name}`;
          memFs.files.set(`${outputs}/${snapshotRelPath}`, { content: 'x', size: 1024 * MB, mtime: FIXED_MTIME, isFile: true });
          entries[originalPath] = {
            originalPath, basename: name, snapshotRelPath, size: 1024 * MB,
            originalMtime: new Date(2025, 0, 1).getTime(), snapshottedAt: snapshottedAtStart + i,
            source: 'tool-output', refId: name, refKind: 'write_file',
          };
        });
        memFs.files.set(`${outputs}/manifest.json`, {
          content: JSON.stringify({ version: 1, entries }), size: 1, mtime: FIXED_MTIME, isFile: true,
        });
        memFs.dirs.add(`${APP_DATA}/conversations`);
        memFs.dirs.add(`${APP_DATA}/conversations/${convId}`);
        memFs.dirs.add(outputs);
      }

      it('evicts the oldest copies across conversations down to 5 GB', async () => {
        seedLegacy(CONV_ID, ['a1', 'a2', 'a3'], 1);
        seedLegacy(OTHER, ['b1', 'b2', 'b3'], 100);

        await mod.enforceTotalCopyLimit(() => false);

        expect(await keptNames(CONV_ID)).toEqual(['a2', 'a3']);
        expect(await keptNames(OTHER)).toEqual(['b1', 'b2', 'b3']);
        expect(memFs.files.has(`${APP_DATA}/conversations/${CONV_ID}/outputs/files/a1/a1`)).toBe(false);
      });

      it('counts a running conversation but takes nothing from it', async () => {
        seedLegacy(CONV_ID, ['a1', 'a2', 'a3'], 1);
        seedLegacy(OTHER, ['b1', 'b2', 'b3'], 100);

        await mod.enforceTotalCopyLimit((convId) => convId === CONV_ID);

        expect(await keptNames(CONV_ID)).toEqual(['a1', 'a2', 'a3']);
        expect(await keptNames(OTHER)).toEqual(['b2', 'b3']);
      });

      it('takes nothing from a conversation that starts running while the pass ranks copies', async () => {
        seedLegacy(CONV_ID, ['a1', 'a2', 'a3'], 1);
        seedLegacy(OTHER, ['b1', 'b2', 'b3'], 100);
        const asked = new Set<string>();

        // Not running when the copies are counted; running by the time one would go.
        await mod.enforceTotalCopyLimit((convId) => {
          if (convId !== CONV_ID) return false;
          const running = asked.has(convId);
          asked.add(convId);
          return running;
        });

        expect(await keptNames(CONV_ID)).toEqual(['a1', 'a2', 'a3']);
        expect(await keptNames(OTHER)).toEqual(['b2', 'b3']);
      });

      it('runs one pass when called twice at once', async () => {
        seedLegacy(CONV_ID, ['a1', 'a2', 'a3'], 1);
        seedLegacy(OTHER, ['b1', 'b2', 'b3'], 100);

        await Promise.all([mod.enforceTotalCopyLimit(() => false), mod.enforceTotalCopyLimit(() => false)]);

        expect(await keptNames(CONV_ID)).toEqual(['a2', 'a3']);
        expect(await keptNames(OTHER)).toEqual(['b1', 'b2', 'b3']);
      });

      it('does nothing at or under the limit', async () => {
        seedLegacy(CONV_ID, ['a1', 'a2'], 1);
        seedLegacy(OTHER, ['b1', 'b2', 'b3'], 100);

        await mod.enforceTotalCopyLimit(() => false);

        expect(await keptNames(CONV_ID)).toEqual(['a1', 'a2']);
        expect(await keptNames(OTHER)).toEqual(['b1', 'b2', 'b3']);
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('hashPath', () => {
    it('produces a stable, fixed-length output for the same input', () => {
      const h1 = mod.__testing.hashPath('/Users/testuser/Desktop/report.csv');
      const h2 = mod.__testing.hashPath('/Users/testuser/Desktop/report.csv');
      expect(h1).toBe(h2);
      expect(h1.length).toBeGreaterThanOrEqual(8);
      expect(h1.length).toBeLessThanOrEqual(16);
    });

    it('produces different outputs for different inputs', () => {
      const h1 = mod.__testing.hashPath('/a/b/c.txt');
      const h2 = mod.__testing.hashPath('/a/b/d.txt');
      expect(h1).not.toBe(h2);
    });
  });
});
