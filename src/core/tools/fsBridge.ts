/**
 * Filesystem bridge for the agent's file tools (P1-2a) — routes the six
 * `@tauri-apps/plugin-fs` calls `src/core/tools/definitions/fileTools.ts`
 * needs (readTextFile / readFile / writeTextFile / readDir / exists / stat)
 * through the sidecar process when it's confirmed healthy, with a
 * byte-identical fallback to the real plugin-fs functions otherwise —
 * mirrors the pattern `src/core/llm/selectChatAdapter.ts` established for
 * LLM transport in P1-1.
 *
 * This is the ONLY module that imports these six functions from
 * '@tauri-apps/plugin-fs' for the tool layer — `fileTools.ts` imports from
 * here instead (see that file's line 1 after the P1-2a import swap). Other
 * plugin-fs callers (the skill loader, etc.) are OUT of scope and keep
 * importing plugin-fs directly; `commandTools` (shell/sandbox), pty, DBs,
 * `append_file`/`atomic_write`, and `move_to_trash` (still a direct Tauri
 * command — see fileTools.ts's deleteFileTool) are also out of scope for
 * this phase.
 *
 * No path-safety logic lives here either — the webview tool layer already
 * runs `pathSafety.ts` checks before calling into this bridge (same trust
 * boundary as calling plugin-fs directly today).
 *
 * ## Fallback policy
 *
 *   - Sidecar not `'running'` right now → go straight to the local
 *     plugin-fs path (byte-identical to pre-P1-2a behavior).
 *   - Sidecar `'running'` but the request fails in a TRANSPORT-shaped way
 *     (request timeout, "Sidecar process closed", or any error that isn't a
 *     recognizable fs-errno `SidecarRpcError` — see `isFsErrorResponse()`)
 *     → warn, retry ONCE via the local plugin-fs path. A file op must not
 *     fail just because the sidecar hiccuped mid-request.
 *   - Sidecar `'running'` and the request fails with a REAL fs error
 *     (ENOENT, EACCES, ...) → surface it faithfully, no retry. The file
 *     genuinely isn't there (or isn't accessible); retrying locally would
 *     just double the latency for the same answer.
 *
 * ## Semantic mapping
 * (server-side half documented in `sidecar/src/fsHost.ts`'s module doc)
 *
 *   - `fs.readFile` returns `{ base64 }` over JSON (binary-unsafe
 *     otherwise) — decoded here via `atob()`, NOT `fetch("data:...")`: the
 *     packaged app's CSP `connect-src` blocks `data:` URIs, which is
 *     exactly the bug that hit image-generation base64 decoding in
 *     production before (MEMORY project-image-generation-model-capability)
 *     — don't reintroduce that pattern here.
 *   - `fs.stat`'s `mtimeMs` (epoch ms, `null` if unavailable) is converted
 *     back to `Date | null` to match plugin-fs's `FileInfo.mtime` shape.
 *   - `fs.readDir` entries already match plugin-fs's `DirEntry` field names
 *     1:1 (`name`/`isDirectory`/`isFile`/`isSymlink`) — no conversion
 *     needed.
 */

import {
  readTextFile as tauriReadTextFile,
  readFile as tauriReadFile,
  writeTextFile as tauriWriteTextFile,
  readDir as tauriReadDir,
  exists as tauriExists,
  stat as tauriStat,
} from '@tauri-apps/plugin-fs';
import { request as sidecarRequest, getSidecarStatus, SidecarRpcError } from '../sidecar/sidecarManager';
import { createLogger } from '../logging/logger';

const logger = createLogger('fs-transport');

/**
 * fs ops shouldn't hang forever like `llm.chat` does (timeoutMs: 0) — a
 * hung read/write must eventually surface an error so the transport-failure
 * fallback below can kick in. 30s gives real headroom for large files /
 * slow disks while still bounding the wait.
 */
const FS_REQUEST_TIMEOUT_MS = 30_000;

export interface FsDirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
}

export interface FsStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  mtime: Date | null;
}

interface RawFsStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  mtimeMs: number | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * True for a REAL fs error — `sidecar/src/fsHost.ts`'s `rethrowFsError()`
 * shape, `{ code, message, path }` — which should be surfaced faithfully,
 * no retry. False for anything transport-shaped (request timeout, "Sidecar
 * process closed", the generic -32603 Internal error wrapping an
 * unclassified host-side throw) — those get one local retry.
 */
function isFsErrorResponse(err: unknown): err is SidecarRpcError & { data: { code: string; message: string; path?: string } } {
  return err instanceof SidecarRpcError && isRecord(err.data) && typeof err.data.code === 'string';
}

/**
 * NOT `fetch("data:...")` — the packaged app's CSP connect-src blocks
 * data: URIs (see module doc). atob() decodes base64 without a network-ish
 * API in the way.
 */
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Shared request/fallback wrapper — see module doc "Fallback policy". Every
 * exported fs function below is a thin wrapper around this: `sidecarCall`
 * performs the RPC and converts its result to the caller's return shape;
 * `localCall` is the plugin-fs path, used both when the sidecar isn't
 * running and as the one-shot retry after a transport-shaped failure.
 */
async function withSidecarFallback<T>(
  method: string,
  path: string,
  sidecarCall: () => Promise<T>,
  localCall: () => Promise<T>,
): Promise<T> {
  const sidecarRunning = getSidecarStatus() === 'running';
  logger.debug('fs op path selected', { method, path, transport: sidecarRunning ? 'sidecar' : 'local' });
  if (!sidecarRunning) {
    return localCall();
  }

  try {
    return await sidecarCall();
  } catch (err) {
    if (isFsErrorResponse(err)) {
      // Real fs error (ENOENT etc.) — surface faithfully, no retry.
      logger.debug('fs op via sidecar hit a real fs error — not retrying', { method, path, code: err.data.code });
      throw new Error(err.data.message, { cause: err });
    }
    // Transport-shaped failure — the sidecar hiccuped, not the file system.
    logger.warn('fs op via sidecar failed (transport) — retrying locally once', {
      method,
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    return localCall();
  }
}

export async function readTextFile(path: string): Promise<string> {
  return withSidecarFallback<string>(
    'fs.readTextFile',
    path,
    async () => (await sidecarRequest('fs.readTextFile', { path }, FS_REQUEST_TIMEOUT_MS)) as string,
    () => tauriReadTextFile(path),
  );
}

export async function readFile(path: string): Promise<Uint8Array> {
  return withSidecarFallback<Uint8Array>(
    'fs.readFile',
    path,
    async () => {
      const res = (await sidecarRequest('fs.readFile', { path }, FS_REQUEST_TIMEOUT_MS)) as { base64: string };
      return base64ToUint8Array(res.base64);
    },
    () => tauriReadFile(path),
  );
}

export async function writeTextFile(path: string, contents: string): Promise<void> {
  return withSidecarFallback<void>(
    'fs.writeTextFile',
    path,
    async () => {
      await sidecarRequest('fs.writeTextFile', { path, contents }, FS_REQUEST_TIMEOUT_MS);
    },
    () => tauriWriteTextFile(path, contents),
  );
}

export async function readDir(path: string): Promise<FsDirEntry[]> {
  return withSidecarFallback<FsDirEntry[]>(
    'fs.readDir',
    path,
    async () => (await sidecarRequest('fs.readDir', { path }, FS_REQUEST_TIMEOUT_MS)) as FsDirEntry[],
    () => tauriReadDir(path),
  );
}

export async function exists(path: string): Promise<boolean> {
  return withSidecarFallback<boolean>(
    'fs.exists',
    path,
    async () => (await sidecarRequest('fs.exists', { path }, FS_REQUEST_TIMEOUT_MS)) as boolean,
    () => tauriExists(path),
  );
}

export async function stat(path: string): Promise<FsStat> {
  return withSidecarFallback<FsStat>(
    'fs.stat',
    path,
    async () => {
      const raw = (await sidecarRequest('fs.stat', { path }, FS_REQUEST_TIMEOUT_MS)) as RawFsStat;
      return {
        isFile: raw.isFile,
        isDirectory: raw.isDirectory,
        isSymlink: raw.isSymlink,
        size: raw.size,
        mtime: raw.mtimeMs === null ? null : new Date(raw.mtimeMs),
      };
    },
    () => tauriStat(path),
  );
}
