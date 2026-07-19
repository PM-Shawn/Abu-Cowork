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

    it('caps at 30 versions per file (+ exempt baseline), evicting the oldest non-baseline', async () => {
      for (let i = 0; i < 35; i++) {
        await mod.snapshotVersion(filePath, `content-${i}`);
      }

      // seq 0 (content-0, the baseline) is exempt from eviction, so the
      // effective cap here is 30 rolling + 1 baseline = 31.
      const versions = await mod.listVersions(filePath);
      expect(versions).toHaveLength(31);

      // Oldest surviving version should be the baseline content-0, then
      // content-5 (1..4 evicted), newest content-34.
      const sorted = [...versions].sort((a, b) => {
        if (a.ts !== b.ts) return a.ts - b.ts;
        return Number(a.id.split('-').pop()) - Number(b.id.split('-').pop());
      });
      const baselineContent = await mod.readVersion(filePath, sorted[0].id);
      const oldestRollingContent = await mod.readVersion(filePath, sorted[1].id);
      const newestContent = await mod.readVersion(filePath, sorted[sorted.length - 1].id);
      expect(baselineContent).toBe('content-0');
      expect(oldestRollingContent).toBe('content-5');
      expect(newestContent).toBe('content-34');

      // Evicted snapshot files should actually be gone from disk.
      const remainingSnapFiles = [...fs.files.keys()].filter((k) => k.endsWith('.snap'));
      expect(remainingSnapFiles).toHaveLength(31);
    });

    it('skips writing a snapshot when content exceeds MAX_SNAPSHOT_BYTES (oversize content is skipped, not truncated)', async () => {
      const oversize = 'a'.repeat(mod.__testing.MAX_SNAPSHOT_BYTES + 1);
      await mod.snapshotVersion(filePath, oversize);

      const versions = await mod.listVersions(filePath);
      expect(versions).toEqual([]);
    });

    it('persists source/label meta when provided and omits them when absent', async () => {
      await mod.snapshotVersion(filePath, 'manual content');
      await mod.snapshotVersion(filePath, 'ai content', { source: 'ai', label: '把标题改成蓝色' });

      const versions = await mod.listVersions(filePath); // most recent first
      expect(versions[0].source).toBe('ai');
      expect(versions[0].label).toBe('把标题改成蓝色');
      expect(versions[1].source).toBeUndefined();
      expect(versions[1].label).toBeUndefined();
    });

    it('parses legacy index.json entries without source/label', async () => {
      await mod.snapshotVersion(filePath, 'old');
      // Simulate a legacy index written before the meta fields existed.
      const indexPath = indexPathFor();
      const index = JSON.parse(fs.files.get(indexPath)!);
      delete index.versions[0].source;
      delete index.versions[0].label;
      fs.files.set(indexPath, JSON.stringify(index));

      const versions = await mod.listVersions(filePath);
      expect(versions).toHaveLength(1);
      expect(versions[0].source).toBeUndefined();
    });

    it('never evicts the original baseline (seq 0) — cap becomes 30 + baseline', async () => {
      await mod.snapshotVersion(filePath, 'baseline'); // seq 0
      for (let i = 1; i <= 35; i++) {
        await mod.snapshotVersion(filePath, `content-${i}`);
      }

      const versions = await mod.listVersions(filePath); // most recent first
      expect(versions).toHaveLength(31); // 30 rolling + 1 exempt baseline
      const oldest = versions[versions.length - 1];
      expect(Number(oldest.id.split('-').pop())).toBe(0);
      await expect(mod.readVersion(filePath, oldest.id)).resolves.toBe('baseline');
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

    it('snapshots the current on-disk state (REVERT_LABEL) before overwriting', async () => {
      await mod.snapshotVersion(filePath, 'old version');
      const versions1 = await mod.listVersions(filePath);
      const oldId = versions1[0].id;

      // Disk has newer, un-snapshotted content at revert time.
      fs.files.set(filePath, 'current disk content');

      const written = await mod.revertToVersion(filePath, oldId);
      expect(written).toBe('old version');
      expect(fs.files.get(filePath)).toBe('old version');

      const versions2 = await mod.listVersions(filePath); // most recent first
      expect(versions2).toHaveLength(2);
      expect(versions2[0].label).toBe(mod.REVERT_LABEL);
      expect(versions2[0].source).toBe('manual');
      await expect(mod.readVersion(filePath, versions2[0].id)).resolves.toBe('current disk content');
    });

    it('does not create a revert-point snapshot when disk already equals the target version', async () => {
      await mod.snapshotVersion(filePath, 'same');
      const versions = await mod.listVersions(filePath);
      fs.files.set(filePath, 'same');

      await mod.revertToVersion(filePath, versions[0].id);
      expect(await mod.listVersions(filePath)).toHaveLength(1);
    });

    it('skips the pre-revert snapshot without relabeling when disk equals the latest snapshot (autosave-then-revert path)', async () => {
      await mod.snapshotVersion(filePath, 'A'); // seq 0
      await mod.snapshotVersion(filePath, 'B'); // autosave snapshot
      fs.files.set(filePath, 'B'); // autosave keeps disk in sync

      const versions1 = await mod.listVersions(filePath);
      const oldId = versions1.find((v) => v.id.endsWith('-0'))!.id;
      await mod.revertToVersion(filePath, oldId);

      // Disk content ('B') already matches the latest history entry, so the
      // full-history dedup (contentExistsInHistory) skips the pre-revert
      // snapshot entirely — no new entry, and the matched entry is NOT
      // relabeled with REVERT_LABEL (it keeps its own identity/meta).
      const versions2 = await mod.listVersions(filePath);
      expect(versions2).toHaveLength(2);
      const latest = versions2[0];
      expect(latest.label).toBeUndefined();
      expect(latest.source).toBeUndefined();
      await expect(mod.readVersion(filePath, latest.id)).resolves.toBe('B');
    });

    it('does not create a duplicate entry when disk content matches a non-latest history entry (e.g. reverting to the baseline)', async () => {
      // History: A (baseline, seq 0), B (latest). Disk currently holds A's
      // content (e.g. the user already manually reverted to the baseline
      // outside the app). Reverting to B must not snapshot "A" again — it's
      // already recoverable from the baseline entry.
      await mod.snapshotVersion(filePath, 'A'); // baseline
      await mod.snapshotVersion(filePath, 'B');
      fs.files.set(filePath, 'A');

      const versionsBefore = await mod.listVersions(filePath); // most recent first: B, A
      const baselineEntry = versionsBefore.find((v) => v.id.endsWith('-0'))!;
      const bEntry = versionsBefore.find((v) => v.id !== baselineEntry.id)!;

      const written = await mod.revertToVersion(filePath, bEntry.id);

      expect(written).toBe('B');
      expect(fs.files.get(filePath)).toBe('B');

      const versionsAfter = await mod.listVersions(filePath);
      expect(versionsAfter).toHaveLength(2); // no new entry created
      const baselineAfter = versionsAfter.find((v) => v.id === baselineEntry.id)!;
      expect(baselineAfter.label).toBeUndefined(); // not polluted with REVERT_LABEL
    });

    it('does not overwrite an existing label on dedupe hit', async () => {
      await mod.snapshotVersion(filePath, 'X', { source: 'ai', label: '用户消息' });
      await mod.snapshotVersion(filePath, 'X', { source: 'manual', label: mod.REVERT_LABEL });

      const versions = await mod.listVersions(filePath);
      expect(versions).toHaveLength(1);
      expect(versions[0].label).toBe('用户消息');
      expect(versions[0].source).toBe('ai');
    });
  });

  // Unused import guard: readDir is mocked (per spec) even though this module
  // doesn't rely on directory listing — index.json is the sole source of truth.
  it('does not require readDir to be called', async () => {
    await mod.snapshotVersion(filePath, 'x');
    expect(readDir).not.toHaveBeenCalled();
  });
});
