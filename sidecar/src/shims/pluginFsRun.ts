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
 *   - `mkdir(path, { recursive, mode })` → `fs.mkdir(path, { recursive, mode })`.
 *   - `remove(path, { recursive })` → `fs.rm(path, { recursive, force:
 *     false })` (plugin-fs's `remove()` throws if the target doesn't exist,
 *     matching Node's default `force: false`).
 *   - `readTextFile`/`writeTextFile` → `fs.readFile(path,'utf-8')`/
 *     `fs.writeFile(path, data, { flag, mode })` — see "Write options" below.
 *   - `readFile`/`writeFile` → `fs.readFile(path)` (returns a `Buffer`,
 *     a `Uint8Array` subclass — structurally compatible with plugin-fs's
 *     `Promise<Uint8Array>`)/`fs.writeFile(path, data, { flag, mode })`
 *     (accepts a `Uint8Array` directly, same as plugin-fs's data param —
 *     verified against `agentLoop.ts`'s own `saveUserImagesToDisk` call
 *     site, which passes a real `Uint8Array`).
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
 * This file replaces the real module only at BUNDLE time; TypeScript still
 * checks every caller against the real plugin's `.d.ts`. So an option this
 * shim ignores is not a compile error anywhere — it is silently dropped at
 * runtime (JS discards extra arguments). A caller that relies on one, e.g.
 * `save_agent`'s `createNew` "never overwrite", would lose that guarantee
 * the day its module became sidecar-reachable. Hence the rule: every
 * side-effecting export either HONORS an option or THROWS on it
 * (`rejectUnsupportedOptions`); none is ignored.
 *
 * Honored: `recursive` (`mkdir`/`remove`), `mode` (`mkdir`, writes), and the
 * write options below. Rejected: `baseDir: BaseDirectory` and copy/rename's
 * per-path variants — each resolves a RELATIVE path against a Tauri app
 * directory the sidecar has no mapping for, so ignoring it would touch a
 * path under the sidecar's cwd instead. No reachable caller passes one
 * (every call site passes an absolute, already-joined path).
 *
 * ── Write options ─────────────────────────────────────────────────────────
 * `writeTextFile`/`writeFile` open the file exactly as tauri-plugin-fs 2.5.1
 * does (`commands.rs` `write_file_inner` → Rust `std::fs::OpenOptions`, with
 * `create` defaulting to `true` and `truncate = !append`):
 *   - `createNew` → `O_CREAT|O_EXCL`: an existing file fails with `EEXIST`,
 *     atomically — no check-then-write window. Wins over `create`.
 *   - `create: false` → no `O_CREAT`: a missing file fails with `ENOENT`
 *     and is not created.
 *   - `append` → `O_APPEND`, never `O_TRUNC`.
 *   - `mode` → the new file's permissions (POSIX only; the plugin ignores it
 *     on Windows, where Node would otherwise turn a mode without the owner
 *     write bit into a read-only file).
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

/** Mirrors plugin-fs's `WriteFileOptions`; `baseDir` is typed only to be rejected. */
export interface FsWriteFileOptions {
  append?: boolean;
  create?: boolean;
  createNew?: boolean;
  mode?: number;
  baseDir?: unknown;
}

/**
 * Throws on any option set to a value that `supported` does not list — see
 * "Options handling" above. `undefined` counts as not set.
 */
function rejectUnsupportedOptions(fn: string, options: object | undefined, supported: readonly string[]): void {
  if (!options) return;
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined && !supported.includes(key)) {
      throw new Error(`pluginFsRun.${fn}: option "${key}" is not supported in the sidecar`);
    }
  }
}

/**
 * `create: false` (the file must already exist) has no Node flag string, and
 * the open(2) flags for it are NOT portable: Windows rejects `O_TRUNC`
 * without `O_CREAT` with `EINVAL` instead of opening the existing file
 * (caught by CI's `test-windows` on the first cut of this shim). `'r+'` opens
 * without ever creating — `ENOENT` when the file is missing, exactly like the
 * plugin — and truncating or seeking to the end reproduces the plugin's
 * `truncate = !append`.
 */
async function writeToExistingFile(path: string, data: string | Uint8Array, append: boolean): Promise<void> {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
  const handle = await fs.open(path, 'r+');
  try {
    const position = append ? (await handle.stat()).size : 0;
    if (!append) await handle.truncate(0);
    await handle.write(bytes, 0, bytes.byteLength, position);
  } finally {
    await handle.close();
  }
}

async function writeWithOptions(fn: string, path: string, data: string | Uint8Array, options?: FsWriteFileOptions): Promise<void> {
  rejectUnsupportedOptions(fn, options, ['append', 'create', 'createNew', 'mode']);
  const append = options?.append ?? false;
  // Only a file this call CREATES takes `mode`, so the create:false path below
  // never needs it. Windows is carved out because the plugin ignores mode there.
  const mode = process.platform === 'win32' ? undefined : options?.mode;
  if (options?.createNew) {
    // 'wx'/'ax' are O_CREAT|O_EXCL: the create itself is the existence check,
    // and createNew wins over create, as in the plugin's Rust OpenOptions.
    await fs.writeFile(path, data, { flag: append ? 'ax' : 'wx', mode });
    return;
  }
  if (options?.create === false) {
    await writeToExistingFile(path, data, append);
    return;
  }
  await fs.writeFile(path, data, { flag: append ? 'a' : 'w', mode });
}

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

/**
 * The same truncation `electron/fsHost.cjs` does, for the same reason: Tauri's
 * Rust `plugin:fs` derives every timestamp with `as_millis()` (truncating),
 * while Node's `Stats.mtime` is `new Date(Math.round(mtimeMs))`. Two shims of
 * one contract must not disagree by a millisecond — the upload identity pin
 * compares this value against `Math.floor(stat.mtimeMs)` in another tier
 * (acceptance F1).
 */
function msecOrNull(ms: number): Date | null {
  if (!Number.isFinite(ms)) return null;
  const date = new Date(Math.floor(ms));
  return Number.isFinite(date.getTime()) ? date : null;
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
    mtime: msecOrNull(s.mtimeMs),
    atime: msecOrNull(s.atimeMs),
    birthtime: msecOrNull(s.birthtimeMs),
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
    mtime: msecOrNull(s.mtimeMs),
    atime: msecOrNull(s.atimeMs),
    birthtime: msecOrNull(s.birthtimeMs),
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

export async function mkdir(path: string, options?: { recursive?: boolean; mode?: number; baseDir?: unknown }): Promise<void> {
  rejectUnsupportedOptions('mkdir', options, ['recursive', 'mode']);
  await fs.mkdir(path, { recursive: options?.recursive ?? false, mode: options?.mode });
}

export async function remove(path: string, options?: { recursive?: boolean; baseDir?: unknown }): Promise<void> {
  rejectUnsupportedOptions('remove', options, ['recursive']);
  await fs.rm(path, { recursive: options?.recursive ?? false, force: false });
}

export async function readTextFile(path: string): Promise<string> {
  return fs.readFile(path, 'utf-8');
}

export async function writeTextFile(path: string, data: string, options?: FsWriteFileOptions): Promise<void> {
  await writeWithOptions('writeTextFile', path, data, options);
}

export async function readFile(path: string): Promise<Uint8Array> {
  return fs.readFile(path);
}

export async function writeFile(path: string, data: Uint8Array, options?: FsWriteFileOptions): Promise<void> {
  await writeWithOptions('writeFile', path, data, options);
}

export async function copyFile(from: string, to: string, options?: { fromPathBaseDir?: unknown; toPathBaseDir?: unknown }): Promise<void> {
  rejectUnsupportedOptions('copyFile', options, []);
  await fs.copyFile(from, to);
}

export async function rename(from: string, to: string, options?: { oldPathBaseDir?: unknown; newPathBaseDir?: unknown }): Promise<void> {
  rejectUnsupportedOptions('rename', options, []);
  await fs.rename(from, to);
}
