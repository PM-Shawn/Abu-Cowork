/**
 * Sidecar-local replacement for `@tauri-apps/plugin-fs`.
 *
 * REAL behavior shim — DIRECT `node:fs/promises` calls against the local
 * disk, NOT a request/response wire round-trip. This is deliberately
 * DIFFERENT from `sidecar/src/fsHost.ts` (the P1-2a fs bridge): that file's
 * own module doc explains it exists to serve the SHELL's `fsBridge.ts`
 * fallback path (webview code calling INTO the sidecar over the wire when
 * the sidecar is running) — the opposite direction from this shim, which
 * serves SIDECAR-resident code (`agentLoop.ts`, `skill/loader.ts`, ...)
 * that wants real fs I/O without a round trip. Both the sidecar and the
 * shell run as sibling processes on the SAME machine, so there is no
 * "wrong disk" risk — a direct `node:fs/promises` call here reads/writes
 * the identical filesystem the shell's Tauri `plugin-fs` calls would.
 *
 * Function-to-node:fs mapping borrowed from `fsHost.ts`'s own established
 * semantic-mapping table (same doc-comment discipline, re-verified against
 * the real `@tauri-apps/plugin-fs` `.d.ts` — `node_modules/@tauri-apps/
 * plugin-fs/dist-js/index.d.ts` — for exact `FileInfo`/`DirEntry` field
 * names, not guessed):
 *   - `readDir` → `fs.readdir(path, { withFileTypes: true })`, `Dirent`'s
 *     `.isDirectory()`/`.isFile()`/`.isSymbolicLink()` map straight onto
 *     `DirEntry`'s `isDirectory`/`isFile`/`isSymlink` fields.
 *   - `stat` → `fs.stat(path)` (follows symlinks, matching plugin-fs's
 *     `stat()` — not `lstat()`, which none of this shim's reachable
 *     callers use); `mtime`/`atime`/`birthtime` become real `Date` objects
 *     directly (no millisecond-number wire projection needed, unlike
 *     `fsHost.ts`'s cross-process `FsStatResult` — we're already in-process
 *     with `node:fs`, so there's no JSON boundary to cross); `isSymlink` is
 *     hardcoded `false` (same reasoning as `fsHost.ts`: a followed `stat()`
 *     result can never itself be a symlink); `readonly` is the same
 *     best-effort POSIX owner-write-bit approximation `fsHost.ts` uses
 *     (`(mode & 0o200) === 0`) — none of this shim's callers read that
 *     field anyway (verified: `grep -n "\.readonly" src/core/session/
 *     outputSnapshots.ts src/core/skill/loader.ts` → no hits).
 *   - `exists` → `fs.access(path)`, `false` on `ENOENT`, rethrow any other
 *     error (matches plugin-fs's `exists()` — only "not found" is a `false`
 *     result, everything else is a real error).
 *   - `mkdir(path, { recursive })` → `fs.mkdir(path, { recursive })`.
 *   - `remove(path, { recursive })` → `fs.rm(path, { recursive, force:
 *     false })` (plugin-fs's `remove()` throws if the target doesn't exist,
 *     matching Node's default `force: false`).
 *   - `readTextFile`/`writeTextFile` → `fs.readFile(path,'utf-8')`/
 *     `fs.writeFile(path, data, 'utf-8')`.
 *   - `readFile`/`writeFile` → `fs.readFile(path)` (returns a `Buffer`,
 *     a `Uint8Array` subclass — structurally compatible with plugin-fs's
 *     `Promise<Uint8Array>`)/`fs.writeFile(path, data)` (accepts a
 *     `Uint8Array` directly, same as plugin-fs's `WriteFileOptions` data
 *     param — verified against `agentLoop.ts`'s own `saveUserImagesToDisk`
 *     call site, which passes a real `Uint8Array`).
 *   - `copyFile(from, to)` → `fs.copyFile(from, to)`.
 *   - `rename(from, to)` → `fs.rename(from, to)`.
 *
 * Consumed export surface verified precisely, not guessed — grepped every
 * function name actually called across `agentLoop.ts`'s
 * `saveUserImagesToDisk` (dynamic import) plus `session/{outputSnapshots,
 * sessionMemory,sessionDir}.ts` and `skill/loader.ts` (all reachable from
 * `agentLoop.ts`'s import graph, static or dynamic — see this batch's
 * report for the full per-file trace): `exists`, `mkdir`, `readTextFile`,
 * `writeTextFile`, `remove`, `stat`, `copyFile`, `rename`, `readFile`,
 * `writeFile`, `readDir` — plus, added by P1-3d-4, `lstat`
 * (`core/tools/pathSafety.ts`'s `isCatastrophicDeleteTarget`/`checkWritePath`
 * use it to detect symlinks WITHOUT following them — dragged in as a
 * whole-module import via `fileTools.ts`'s `deleteFileTool`, even though
 * none of the four read-path tools this batch migrates call it; same
 * "whole-module import" reason as `pluginOsRun.ts`'s doc). `open`/`create`/
 * `watch`/`truncate`/`size`/... are never imported by any reachable file,
 * correctly omitted.
 *
 * ── Options handling ──────────────────────────────────────────────────────
 * All real `@tauri-apps/plugin-fs` functions accept an options object whose
 * ONLY field any reachable caller ever sets is `recursive` (on `mkdir`/
 * `remove`) — `baseDir: BaseDirectory` (a Tauri scoped-directory enum) is
 * NEVER used by any reachable caller (verified by grep — every call site
 * passes an absolute, already-joined path, never a `baseDir` option), so
 * this shim doesn't implement that half of the options surface at all.
 *
 * ── Error shape ────────────────────────────────────────────────────────────
 * Node fs errno errors (`ENOENT`, `EACCES`, ...) propagate AS-IS (real
 * `Error` instances with a `.code` string) — unlike `fsHost.ts`, which wraps
 * them in an `RpcError` for its cross-process wire contract, there is no
 * wire boundary here, so no wrapping is needed; every reachable caller
 * already handles fs errors via bare `try/catch` (verified: every call site
 * across the 5 files this shim serves wraps its fs calls in `try/catch`),
 * matching plugin-fs's own behavior of rejecting with a real `Error`.
 */
import * as fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';

export interface FsDirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
}

export async function readDir(path: string): Promise<FsDirEntry[]> {
  const entries = await fs.readdir(path, { withFileTypes: true });
  return entries.map((entry: Dirent) => ({
    name: entry.name,
    isDirectory: entry.isDirectory(),
    isFile: entry.isFile(),
    isSymlink: entry.isSymbolicLink(),
  }));
}

export interface FsFileInfo {
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  mtime: Date | null;
  atime: Date | null;
  birthtime: Date | null;
  readonly: boolean;
}

export async function stat(path: string): Promise<FsFileInfo> {
  const s = await fs.stat(path);
  return {
    isFile: s.isFile(),
    isDirectory: s.isDirectory(),
    isSymlink: false,
    size: s.size,
    mtime: Number.isFinite(s.mtimeMs) ? s.mtime : null,
    atime: Number.isFinite(s.atimeMs) ? s.atime : null,
    birthtime: Number.isFinite(s.birthtimeMs) ? s.birthtime : null,
    readonly: (s.mode & 0o200) === 0,
  };
}

/**
 * P1-3d-4 — does NOT follow symlinks (`fs.lstat`, not `fs.stat`), matching
 * plugin-fs's `lstat()` exactly: `isSymlink` reflects the path ITSELF, so a
 * symlink reports `isSymlink: true` (and `isFile`/`isDirectory` both
 * `false`, `Dirent`-style) rather than resolving through to its target —
 * the opposite of this file's own `stat()` above.
 */
export async function lstat(path: string): Promise<FsFileInfo> {
  const s = await fs.lstat(path);
  return {
    isFile: s.isFile(),
    isDirectory: s.isDirectory(),
    isSymlink: s.isSymbolicLink(),
    size: s.size,
    mtime: Number.isFinite(s.mtimeMs) ? s.mtime : null,
    atime: Number.isFinite(s.atimeMs) ? s.atime : null,
    birthtime: Number.isFinite(s.birthtimeMs) ? s.birthtime : null,
    readonly: (s.mode & 0o200) === 0,
  };
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

export async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }
}

export async function mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
  await fs.mkdir(path, { recursive: options?.recursive ?? false });
}

export async function remove(path: string, options?: { recursive?: boolean }): Promise<void> {
  await fs.rm(path, { recursive: options?.recursive ?? false, force: false });
}

export async function readTextFile(path: string): Promise<string> {
  return fs.readFile(path, 'utf-8');
}

export async function writeTextFile(path: string, data: string): Promise<void> {
  await fs.writeFile(path, data, 'utf-8');
}

export async function readFile(path: string): Promise<Uint8Array> {
  return fs.readFile(path);
}

export async function writeFile(path: string, data: Uint8Array): Promise<void> {
  await fs.writeFile(path, data);
}

export async function copyFile(from: string, to: string): Promise<void> {
  await fs.copyFile(from, to);
}

export async function rename(from: string, to: string): Promise<void> {
  await fs.rename(from, to);
}
