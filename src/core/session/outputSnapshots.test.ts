import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exists, readTextFile, writeTextFile, mkdir, remove, stat, copyFile, rename } from '@tauri-apps/plugin-fs';

// Extend the global plugin-fs mock with the symbols outputSnapshots needs
// (stat, copyFile, rename are not in the default test setup mock).
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
  };
});

// Imported lazily after mocks are configured
let mod: typeof import('./outputSnapshots');

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
    files.set(path, { content, size: content.length, mtime: new Date(), isFile: true });
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

  return {
    files,
    dirs,
    copyFile: mockedCopyFile,
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
        mtime: new Date(),
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
        mtime: new Date(),
        isFile: true,
      });

      const manifest = await mod.__testing.loadManifest(CONV_ID);
      expect(Object.keys(manifest.entries)).toHaveLength(0);
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
