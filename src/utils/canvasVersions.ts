/**
 * Canvas version snapshots — a simple, non-git, per-file history mechanism
 * for the code canvas preview panel (activedoc canvas P4).
 *
 * Design: full-content snapshots (not diffs), following WorkBuddy's
 * self-built per-file history (see reference-workbuddy-file-checkpoint-mechanism
 * in project memory). V1 deliberately doesn't shell out to git2 — this is a
 * lightweight "undo history" for files edited in the preview panel, not a
 * VCS.
 *
 * Storage layout:
 *   ~/.abu/canvas-history/<pathHash>/
 *   ├── index.json            { path, seq, versions: VersionMeta[] }
 *   └── <ts>-<seq>.snap        full content, one file per version
 *
 * `pathHash` = sha256(normalized absolute path).slice(0, 16) — keeps every
 * file's history in its own directory without leaking the real path into a
 * directory name.
 */

import { exists, mkdir, readTextFile, remove } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { joinPath, normalizeSeparators } from '@/utils/pathUtils';
import { atomicWrite } from '@/utils/atomicFs';

/** Max snapshots retained per file — oldest are evicted beyond this. */
const MAX_VERSIONS_PER_FILE = 30;

export interface VersionMeta {
  id: string;
  ts: number;
  byteSize: number;
}

interface VersionIndex {
  path: string;
  /** Monotonic counter for generating unique snapshot ids. Never decreases,
   *  even as old versions are evicted, so ids never collide. */
  seq: number;
  versions: VersionMeta[];
}

let cachedHomeDir: string | null = null;

async function getHomeDir(): Promise<string> {
  if (!cachedHomeDir) cachedHomeDir = await homeDir();
  return cachedHomeDir;
}

/** Normalize a path to canonical form (forward slashes, no trailing slash). */
function normalizePath(p: string): string {
  return normalizeSeparators(p).replace(/\/+$/, '');
}

/** SHA-256 hash of a string via Web Crypto, hex-encoded, truncated to 16 chars. */
async function sha256Hex16(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex.slice(0, 16);
}

async function getHistoryDir(filePath: string): Promise<string> {
  const home = await getHomeDir();
  const hash = await sha256Hex16(normalizePath(filePath));
  return joinPath(home, '.abu', 'canvas-history', hash);
}

function getIndexPath(dir: string): string {
  return joinPath(dir, 'index.json');
}

function snapFileName(id: string): string {
  return `${id}.snap`;
}

/** Load index.json for a file's history dir. Corrupt/missing → empty history, never throws. */
async function loadIndex(dir: string, filePath: string): Promise<VersionIndex> {
  const indexPath = getIndexPath(dir);
  try {
    if (await exists(indexPath)) {
      const text = await readTextFile(indexPath);
      const parsed = JSON.parse(text) as Partial<VersionIndex>;
      if (Array.isArray(parsed.versions)) {
        return {
          path: parsed.path ?? filePath,
          seq: typeof parsed.seq === 'number' ? parsed.seq : parsed.versions.length,
          versions: parsed.versions,
        };
      }
    }
  } catch (err) {
    console.warn('[canvasVersions] index.json load failed, treating as empty history', filePath, err);
  }
  return { path: filePath, seq: 0, versions: [] };
}

async function saveIndex(dir: string, index: VersionIndex): Promise<void> {
  // Atomic (temp + rename) so a crash mid-write can't corrupt index.json and
  // lose the whole file's history; also makes the lock-free read in
  // listVersions torn-read-safe (a reader sees the complete old or new file,
  // never a partial one).
  await atomicWrite(getIndexPath(dir), JSON.stringify(index, null, 2));
}

async function readSnapshotContent(dir: string, id: string): Promise<string | null> {
  const path = joinPath(dir, snapFileName(id));
  try {
    if (!(await exists(path))) return null;
    return await readTextFile(path);
  } catch {
    return null;
  }
}

// Per-history-dir lock so a baseline snapshot (on file load) and an autosave
// snapshot firing in close succession can't race on the index.json
// read-modify-write cycle (mirrors outputSnapshots.ts's withConvLock).
const dirLocks = new Map<string, Promise<unknown>>();

async function withDirLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = dirLocks.get(dir) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const guarded = next.catch(() => undefined);
  dirLocks.set(dir, guarded);
  // Drop the map entry once this op settles if nothing else queued behind it,
  // so the map doesn't grow one permanent entry per distinct edited file over
  // a long session.
  void guarded.then(() => {
    if (dirLocks.get(dir) === guarded) dirLocks.delete(dir);
  });
  return next;
}

/**
 * Take a snapshot of `content` for `filePath`. No-ops when `content` matches
 * the most recent snapshot — repeated autosaves of unchanged content
 * shouldn't grow the history.
 *
 * When the per-file cap (`MAX_VERSIONS_PER_FILE`) is exceeded, the oldest
 * snapshot file + index entry are evicted.
 */
export async function snapshotVersion(filePath: string, content: string): Promise<void> {
  const dir = await getHistoryDir(filePath);

  await withDirLock(dir, async () => {
    if (!(await exists(dir))) await mkdir(dir, { recursive: true });

    const index = await loadIndex(dir, filePath);
    const latest = index.versions[index.versions.length - 1];
    const byteSize = new TextEncoder().encode(content).length;

    // Dedupe against the most recent snapshot. Compare the cheap byteSize
    // first (already tracked in the index) and only read the full previous
    // .snap back from disk when the sizes actually match — avoids a full-file
    // read on every autosave of changed content.
    if (latest && latest.byteSize === byteSize) {
      const latestContent = await readSnapshotContent(dir, latest.id);
      if (latestContent !== null && latestContent === content) return;
    }

    const ts = Date.now();
    const seq = index.seq;
    const id = `${ts}-${seq}`;

    // Atomic so a crash mid-write can't leave a truncated .snap that a later
    // revert would atomicWrite verbatim over the user's live document.
    await atomicWrite(joinPath(dir, snapFileName(id)), content);

    index.seq = seq + 1;
    index.path = filePath;
    index.versions.push({ id, ts, byteSize });

    while (index.versions.length > MAX_VERSIONS_PER_FILE) {
      const oldest = index.versions.shift();
      if (oldest) {
        try {
          await remove(joinPath(dir, snapFileName(oldest.id)));
        } catch (err) {
          console.warn('[canvasVersions] failed to remove evicted snapshot', filePath, oldest.id, err);
        }
      }
    }

    await saveIndex(dir, index);
  });
}

/** List all versions for `filePath`, most recent first. Empty array if no history (or on any read failure). */
export async function listVersions(filePath: string): Promise<VersionMeta[]> {
  const dir = await getHistoryDir(filePath);
  const index = await loadIndex(dir, filePath);
  // Tie-break same-millisecond snapshots (common in fast succession / tests)
  // by the monotonic `seq` suffix embedded in the id, so insertion order is
  // preserved even when Date.now() doesn't advance between two snapshots.
  return [...index.versions].sort((a, b) => {
    if (b.ts !== a.ts) return b.ts - a.ts;
    return Number(b.id.split('-').pop()) - Number(a.id.split('-').pop());
  });
}

/** Read a single snapshot's full content by id. Throws if the snapshot file is missing. */
export async function readVersion(filePath: string, id: string): Promise<string> {
  const dir = await getHistoryDir(filePath);
  return await readTextFile(joinPath(dir, snapFileName(id)));
}

/**
 * Revert `filePath` on disk to the content of snapshot `id`.
 * Reads the snapshot, atomically writes it back to `filePath`, and returns
 * the written content (so callers can update in-memory state immediately
 * without waiting on the fs-watch round trip).
 */
export async function revertToVersion(filePath: string, id: string): Promise<string> {
  const content = await readVersion(filePath, id);
  await atomicWrite(filePath, content);
  return content;
}

/** @internal — exposed for unit tests only */
export const __testing = {
  sha256Hex16,
  normalizePath,
  MAX_VERSIONS_PER_FILE,
};
