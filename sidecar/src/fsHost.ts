/**
 * Filesystem host — sidecar-side handlers for the `fs.*` JSON-RPC methods
 * (P1-2a). Implements the six fs operations
 * `src/core/tools/definitions/fileTools.ts` needs, using `node:fs/promises`,
 * so the shell's `src/core/tools/fsBridge.ts` can route those calls through
 * this process instead of `@tauri-apps/plugin-fs` whenever the sidecar is
 * running — see fsBridge.ts's module doc for the shell-side half of the
 * fallback contract.
 *
 * No path-safety / permission logic lives here — the webview tool layer
 * (`src/core/tools/pathSafety.ts`) already gates writes/deletes before ever
 * calling into this bridge; this host trusts its caller exactly as
 * `@tauri-apps/plugin-fs` does today (same trust boundary, just relocated
 * into this process).
 *
 * ## Semantic mapping to @tauri-apps/plugin-fs
 * (see also fsBridge.ts's module doc, and P1-2a-REPORT.md for the full
 * side-by-side table)
 *
 *   - `fs.readDir` uses `fs.readdir(path, { withFileTypes: true })` —
 *     `Dirent`'s type comes from the directory entry itself (`d_type`), NOT
 *     a followed `stat()`, exactly matching Rust's
 *     `std::fs::DirEntry::file_type()` that plugin-fs's `readDir` command
 *     uses under the hood. A symlink entry therefore reports
 *     `isSymlink: true, isFile: false, isDirectory: false` — the LINK
 *     itself, not whatever it points to, on both sides (lstat-shaped, even
 *     though nothing here calls `lstat()` directly — it's the natural
 *     behavior of an unfollowed directory-entry type on both platforms).
 *   - `fs.stat` uses `fs.stat(path)` (follows symlinks), matching
 *     plugin-fs's `stat()` — NOT `lstat()`, which plugin-fs reserves for
 *     link-info and which `fileTools.ts` never calls. Because `stat()`
 *     always resolves through any symlink, the final target can never
 *     itself be a symlink, so `isSymlink` is hardcoded `false` in the
 *     result (mirrors plugin-fs's own `FileInfo.isSymlink` for `stat()`
 *     results).
 *   - `mtime`/`atime`/`birthtime` are sent as epoch-millisecond numbers
 *     (`null` if the platform doesn't report a finite value) — JSON has no
 *     `Date` type. The bridge reconstructs `new Date(ms)` client-side to
 *     match plugin-fs's `FileInfo.mtime: Date | null` shape.
 *   - `readonly` is a best-effort POSIX approximation (owner write-bit) —
 *     plugin-fs derives its `FileInfo.readonly` from the platform's actual
 *     ACL/attribute check, which node:fs doesn't expose directly.
 *     `fileTools.ts` never reads this field today.
 *
 * ## Error shape
 *
 * Node fs errno errors (ENOENT, EACCES, EISDIR, ...) are rethrown as
 * `RpcError(-32001, message, { code, message, path })` so the bridge can
 * decide whether to surface the error faithfully (a real fs error) or retry
 * locally once (a transport hiccup) — see fsBridge.ts's
 * `isFsErrorResponse()`. Anything that ISN'T a recognizable errno error (a
 * bug in this host, an unexpected throw) falls through unrewrapped;
 * `main.ts`'s `errorFromCaught()` then wraps it as the generic -32603
 * Internal error, which fsBridge.ts treats as transport-shaped (retry
 * locally) — the safer default for something we can't classify as "the file
 * genuinely isn't there."
 */

import * as fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { RpcError } from './protocol';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requirePath(params: unknown, method: string): string {
  if (!isRecord(params) || typeof params.path !== 'string' || !params.path) {
    throw new RpcError(-32602, `Invalid params: ${method} requires a non-empty string "path"`);
  }
  return params.path;
}

/** Node's fs rejections are always `Error` with a string `.code` (ENOENT, EACCES, ...). */
function isNodeErrnoError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}

/**
 * fs errno errors -> RpcError carrying `{ code, message, path }` in `data`
 * — see module doc "Error shape". Anything else is rethrown as-is (main.ts
 * wraps it generically).
 */
function rethrowFsError(err: unknown, path: string): never {
  if (isNodeErrnoError(err)) {
    throw new RpcError(-32001, err.message, { code: err.code ?? 'UNKNOWN', message: err.message, path });
  }
  throw err;
}

export async function fsReadTextFile(params: unknown): Promise<string> {
  const path = requirePath(params, 'fs.readTextFile');
  try {
    return await fs.readFile(path, 'utf-8');
  } catch (err) {
    rethrowFsError(err, path);
  }
}

export interface FsReadFileResult {
  base64: string;
}

export async function fsReadFile(params: unknown): Promise<FsReadFileResult> {
  const path = requirePath(params, 'fs.readFile');
  try {
    const buf = await fs.readFile(path);
    return { base64: buf.toString('base64') };
  } catch (err) {
    rethrowFsError(err, path);
  }
}

export async function fsWriteTextFile(params: unknown): Promise<null> {
  if (!isRecord(params) || typeof params.path !== 'string' || !params.path || typeof params.contents !== 'string') {
    throw new RpcError(-32602, 'Invalid params: fs.writeTextFile requires a non-empty string "path" and a string "contents"');
  }
  const path = params.path;
  const contents = params.contents;
  try {
    // plugin-fs's writeTextFile defaults `create: true` (create-or-truncate,
    // no append) — node's default write flag ('w') matches exactly.
    await fs.writeFile(path, contents, 'utf-8');
    return null;
  } catch (err) {
    rethrowFsError(err, path);
  }
}

export interface FsDirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
}

export async function fsReadDir(params: unknown): Promise<FsDirEntry[]> {
  const path = requirePath(params, 'fs.readDir');
  try {
    const entries = await fs.readdir(path, { withFileTypes: true });
    return entries.map((entry: Dirent) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
      isSymlink: entry.isSymbolicLink(),
    }));
  } catch (err) {
    rethrowFsError(err, path);
  }
}

export async function fsExists(params: unknown): Promise<boolean> {
  const path = requirePath(params, 'fs.exists');
  try {
    await fs.access(path);
    return true;
  } catch (err) {
    if (isNodeErrnoError(err) && err.code === 'ENOENT') return false;
    // Any other error (e.g. permission denied on a parent directory) is
    // surfaced rather than silently reported as "doesn't exist" — matches
    // plugin-fs's `exists()`, which only special-cases "not found".
    rethrowFsError(err, path);
  }
}

export interface FsStatResult {
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  mtimeMs: number | null;
  atimeMs: number | null;
  birthtimeMs: number | null;
  readonly: boolean;
}

export async function fsStat(params: unknown): Promise<FsStatResult> {
  const path = requirePath(params, 'fs.stat');
  try {
    // Follows symlinks — matches plugin-fs's `stat()` (not `lstat()`); see
    // module doc "Semantic mapping".
    const s = await fs.stat(path);
    return {
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      isSymlink: false,
      size: s.size,
      mtimeMs: Number.isFinite(s.mtimeMs) ? s.mtimeMs : null,
      atimeMs: Number.isFinite(s.atimeMs) ? s.atimeMs : null,
      birthtimeMs: Number.isFinite(s.birthtimeMs) ? s.birthtimeMs : null,
      readonly: (s.mode & 0o200) === 0,
    };
  } catch (err) {
    rethrowFsError(err, path);
  }
}
