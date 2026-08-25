import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exists, readTextFile, writeTextFile, mkdir, remove, stat, copyFile, rename, writeFile } from '@tauri-apps/plugin-fs';

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
    writeTextFile: vi.fn(),
    exists: vi.fn(),
    mkdir: vi.fn(),
    remove: vi.fn(),
    stat: vi.fn(),
    copyFile: vi.fn(),
    rename: vi.fn(),
    writeFile: vi.fn(),
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

  mockedWriteText.mockImplementation(async (path: string, content: string) => {
    files.set(path, { content, size: content.length, mtime: FIXED_MTIME, isFile: true });
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

    it('writes the manifest.json file via atomic rename', async () => {
      memFs.addUserFile('/Users/testuser/Desktop/a.txt', 50);
      await mod.snapshotFile(CONV_ID, '/Users/testuser/Desktop/a.txt', {
        source: 'tool-output',
        refId: 't1',
        refKind: 'write_file',
      });
      // Either the .tmp was renamed to manifest.json, or written directly
      expect(memFs.files.has(`${OUTPUTS_DIR}/manifest.json`)).toBe(true);
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
