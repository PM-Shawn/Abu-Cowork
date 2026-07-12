import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exists, readTextFile, writeTextFile, mkdir, readDir, remove } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';

// Extend the global plugin-fs mock with an in-memory filesystem so the
// module's read-modify-write cycles (index.json + .snap files) can be
// exercised without touching real disk.
vi.mock('@tauri-apps/plugin-fs', async () => {
  const actual = await vi.importActual<typeof import('@tauri-apps/plugin-fs')>('@tauri-apps/plugin-fs');
  return {
    ...actual,
    readTextFile: vi.fn(),
    writeTextFile: vi.fn(),
    exists: vi.fn(),
    mkdir: vi.fn(),
    readDir: vi.fn(),
    remove: vi.fn(),
  };
});

function createMemoryFs() {
  const files = new Map<string, string>();
  const dirs = new Set<string>();

  const mockedExists = exists as ReturnType<typeof vi.fn>;
  const mockedReadText = readTextFile as ReturnType<typeof vi.fn>;
  const mockedWriteText = writeTextFile as ReturnType<typeof vi.fn>;
  const mockedMkdir = mkdir as ReturnType<typeof vi.fn>;
  const mockedRemove = remove as ReturnType<typeof vi.fn>;

  mockedExists.mockImplementation(async (path: string) => files.has(path) || dirs.has(path));

  mockedReadText.mockImplementation(async (path: string) => {
    if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
    return files.get(path)!;
  });

  mockedWriteText.mockImplementation(async (path: string, content: string) => {
    files.set(path, content);
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  });

  mockedMkdir.mockImplementation(async (path: string) => {
    dirs.add(path);
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  });

  mockedRemove.mockImplementation(async (path: string) => {
    files.delete(path);
    dirs.delete(path);
  });

  return { files, dirs };
}

const mockInvoke = vi.mocked(invoke);

let mod: typeof import('./canvasVersions');

describe('canvasVersions', () => {
  let fs: ReturnType<typeof createMemoryFs>;
  const filePath = '/workspace/site/index.html';

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    fs = createMemoryFs();
    mockInvoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'atomic_write_text') {
        fs.files.set(args!.path as string, args!.content as string);
        return undefined;
      }
      return undefined;
    });
    mod = await import('./canvasVersions');
  });

  function indexPathFor(): string {
    // Every write goes through a single hash-derived dir per test file path;
    // grab it by inspecting the (only) index.json key written so far.
    const key = [...fs.files.keys()].find((k) => k.endsWith('index.json'));
    if (!key) throw new Error('no index.json written yet');
    return key;
  }

  describe('snapshotVersion', () => {
    it('creates index.json + a .snap file on first snapshot', async () => {
      await mod.snapshotVersion(filePath, 'hello world');

      const indexPath = indexPathFor();
      const index = JSON.parse(fs.files.get(indexPath)!);
      expect(index.versions).toHaveLength(1);
      expect(index.versions[0].byteSize).toBe(new TextEncoder().encode('hello world').length);

      const versions = await mod.listVersions(filePath);
      expect(versions).toHaveLength(1);
      const content = await mod.readVersion(filePath, versions[0].id);
      expect(content).toBe('hello world');
    });

    it('skips writing a new snapshot when content matches the latest one (dedupe)', async () => {
      await mod.snapshotVersion(filePath, 'same content');
      await mod.snapshotVersion(filePath, 'same content');
      await mod.snapshotVersion(filePath, 'same content');

      const versions = await mod.listVersions(filePath);
      expect(versions).toHaveLength(1);
    });

    it('adds a new version when content differs from the latest snapshot', async () => {
      await mod.snapshotVersion(filePath, 'v1');
      await mod.snapshotVersion(filePath, 'v2');

      const versions = await mod.listVersions(filePath);
      expect(versions).toHaveLength(2);
    });

    it('caps at 30 versions per file, evicting the oldest', async () => {
      for (let i = 0; i < 35; i++) {
        await mod.snapshotVersion(filePath, `content-${i}`);
      }

      const versions = await mod.listVersions(filePath);
      expect(versions).toHaveLength(30);

      // Oldest surviving version should be content-5 (0..4 evicted), newest content-34.
      const sorted = [...versions].sort((a, b) => {
        if (a.ts !== b.ts) return a.ts - b.ts;
        return Number(a.id.split('-').pop()) - Number(b.id.split('-').pop());
      });
      const oldestContent = await mod.readVersion(filePath, sorted[0].id);
      const newestContent = await mod.readVersion(filePath, sorted[sorted.length - 1].id);
      expect(oldestContent).toBe('content-5');
      expect(newestContent).toBe('content-34');

      // Evicted snapshot files should actually be gone from disk.
      const remainingSnapFiles = [...fs.files.keys()].filter((k) => k.endsWith('.snap'));
      expect(remainingSnapFiles).toHaveLength(30);
    });
  });

  describe('listVersions', () => {
    it('returns versions sorted by ts descending (most recent first)', async () => {
      await mod.snapshotVersion(filePath, 'a');
      await mod.snapshotVersion(filePath, 'b');
      await mod.snapshotVersion(filePath, 'c');

      const versions = await mod.listVersions(filePath);
      expect(versions).toHaveLength(3);
      for (let i = 0; i < versions.length - 1; i++) {
        expect(versions[i].ts).toBeGreaterThanOrEqual(versions[i + 1].ts);
      }
      const latest = await mod.readVersion(filePath, versions[0].id);
      expect(latest).toBe('c');
    });

    it('returns an empty array when there is no history at all', async () => {
      const versions = await mod.listVersions('/never/snapshotted.txt');
      expect(versions).toEqual([]);
    });

    it('treats a corrupted index.json as empty history instead of throwing', async () => {
      await mod.snapshotVersion(filePath, 'v1');
      const indexPath = indexPathFor();
      fs.files.set(indexPath, '{ this is not valid json');

      await expect(mod.listVersions(filePath)).resolves.toEqual([]);
    });
  });

  describe('revertToVersion', () => {
    it('reads the snapshot and atomically writes it back to the original path', async () => {
      await mod.snapshotVersion(filePath, 'original content');
      await mod.snapshotVersion(filePath, 'edited content');

      const versions = await mod.listVersions(filePath);
      expect(versions).toHaveLength(2);

      // Revert to the oldest (original) version. Sort ascending by ts, then
      // by the id's seq suffix to break same-millisecond ties deterministically.
      const oldest = [...versions].sort((a, b) => {
        if (a.ts !== b.ts) return a.ts - b.ts;
        return Number(a.id.split('-').pop()) - Number(b.id.split('-').pop());
      })[0];
      const written = await mod.revertToVersion(filePath, oldest.id);

      expect(written).toBe('original content');
      expect(mockInvoke).toHaveBeenCalledWith('atomic_write_text', {
        path: filePath,
        content: 'original content',
      });
      expect(fs.files.get(filePath)).toBe('original content');
    });
  });

  // Unused import guard: readDir is mocked (per spec) even though this module
  // doesn't rely on directory listing — index.json is the sole source of truth.
  it('does not require readDir to be called', async () => {
    await mod.snapshotVersion(filePath, 'x');
    expect(readDir).not.toHaveBeenCalled();
  });
});
