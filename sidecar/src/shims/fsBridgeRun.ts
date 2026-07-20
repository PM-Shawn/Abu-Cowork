/**
 * Sidecar-local replacement for `src/core/tools/fsBridge.ts` (P1-3d-4,
 * docs/2026-07-21-phase1-p3d-tool-migration-design.md §5 row "3d-4").
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * The REAL `fsBridge.ts` is a SHELL-side module: it's the client half of a
 * request/response pair whose SERVER half is `sidecar/src/fsHost.ts` (P1-2a)
 * — the shell calls `sidecarRequest('fs.readTextFile', ...)` (via
 * `sidecarManager.ts`) to ask the sidecar process to do the read, falling
 * back to real `@tauri-apps/plugin-fs` calls if the sidecar isn't running or
 * the RPC fails transport-wise (see `fsBridge.ts`'s own module doc for that
 * fallback policy — it's a SHELL-only concern, not relevant here).
 *
 * `fileTools.ts`'s read/list/search/find tools import `fsBridge.ts` — when
 * their `execute()` runs LOCALLY, in-process, inside the sidecar itself
 * (P1-3d-4's whole point), there is no "shell to call the sidecar" relationship
 * to speak of: we ARE the sidecar. Calling the real `fsBridge.ts` from here
 * would be nonsensical (asking ourselves, over an RPC channel that doesn't
 * exist in this direction) AND would drag `@tauri-apps/plugin-fs` +
 * `sidecarManager.ts` (which itself imports `@tauri-apps/api/event`) into
 * the sidecar bundle — both forbidden, confirmed empirically via
 * `ABU_SHIM_DEBUG=1 npm run build:sidecar` before this shim existed.
 *
 * This shim instead calls `fsHost.ts`'s REAL handlers DIRECTLY, in-process —
 * no RPC round-trip needed, since the "server" and "client" are now the same
 * process — and adapts their RPC-shaped signatures
 * (`(params: unknown) => Promise<...>`, base64-encoded bytes, epoch-ms
 * timestamps) back to `fsBridge.ts`'s plain client-facing shape (`(path,
 * ...): Promise<...>`, `Uint8Array`, `Date | null`) — mirroring EXACTLY the
 * same base64→Uint8Array / mtimeMs→Date conversions the real `fsBridge.ts`
 * does client-side (see that file's `base64ToUint8Array` and its `stat()`'s
 * `mtime: raw.mtimeMs === null ? null : new Date(raw.mtimeMs)`), so a
 * locally-executed file tool sees byte-identical results to the reverse
 * `tool.invoke` path.
 *
 * fsHost.ts's own errno→RpcError wrapping (`rethrowFsError`) already
 * produces a real `Error` on rejection (via `main.ts`'s RpcError being a
 * subclass of `Error`) — that propagates through this shim unchanged; the
 * caller (`fileTools.ts`'s tools) already just does `err instanceof Error ?
 * err.message : String(err)` in its own catch blocks, so no further
 * translation is needed here (unlike `fsBridge.ts`'s shell-side
 * `isFsErrorResponse()` classification, which exists only to decide
 * "retry locally once?" — a question that doesn't apply here, there is no
 * second tier to retry against).
 */
import { fsReadTextFile, fsReadFile, fsWriteTextFile, fsReadDir, fsExists, fsStat } from '../fsHost';

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

/** Byte-identical to `fsBridge.ts`'s own base64 decode (same algorithm, same reason: no `fetch("data:...")`, CSP-agnostic here anyway since Node has no CSP — kept identical for a single obvious "this is the same operation" reading). */
function base64ToUint8Array(base64: string): Uint8Array {
  const buf = Buffer.from(base64, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export async function readTextFile(path: string): Promise<string> {
  return fsReadTextFile({ path });
}

export async function readFile(path: string): Promise<Uint8Array> {
  const { base64 } = await fsReadFile({ path });
  return base64ToUint8Array(base64);
}

export async function writeTextFile(path: string, contents: string): Promise<void> {
  await fsWriteTextFile({ path, contents });
}

export async function readDir(path: string): Promise<FsDirEntry[]> {
  return fsReadDir({ path });
}

export async function exists(path: string): Promise<boolean> {
  return fsExists({ path });
}

export async function stat(path: string): Promise<FsStat> {
  const raw = await fsStat({ path });
  return {
    isFile: raw.isFile,
    isDirectory: raw.isDirectory,
    isSymlink: raw.isSymlink,
    size: raw.size,
    mtime: raw.mtimeMs === null ? null : new Date(raw.mtimeMs),
  };
}
