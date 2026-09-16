/**
 * Sidecar-local replacement for `src/core/memdir/paths.ts`.
 *
 * NEW finding beyond the P1-3a-pre inventory (which only traced STATIC
 * top-of-file imports): `subagentLoop.ts` does a DYNAMIC
 * `await import('../memdir/scan')` mid-function (its "Load and inject
 * persistent memory from memdir" step) — `scan.ts` in turn imports
 * `getMemoryDir` from THIS module, which imports `homeDir` from
 * `@tauri-apps/api/path`. Per the card's hard rule ("no silent no-op shim
 * for anything behavior-bearing"): memory injection is real product
 * behavior (it shapes the subagent's system prompt), and it would
 * otherwise fail on EVERY sidecar-run subagent (not a rare edge case) if
 * left unshimmed — that's a silent, total feature loss, not an acceptable
 * degradation. So this gets a real shim, not a stub.
 *
 * Home comes from `bootstrap.ts`'s `resolveHomeDir()` — the shell's own
 * resolved home passed down as the `ABU_HOME_DIR` spawn env var, falling
 * back to `os.homedir()` (the direct Node equivalent of Tauri's `homeDir()`
 * — sidecar and webview are separate PROCESSES but always siblings on the
 * SAME machine). The env var matters because the shell's home is NOT always
 * the OS home: E2E launches redirect `app.getPath('home')` into an isolated
 * data root (see electron/main.cjs), and both sides must keep resolving the
 * identical `~/.abu/...` paths for the same workspace — the shell and the
 * sidecar both read/write the same memory files across different runs.
 *
 * `sanitizePath`/`djb2Hash`/directory-composition logic is copied
 * VERBATIM from the real `paths.ts` (not reimplemented from scratch) to
 * guarantee byte-identical output paths on both sides of the process
 * boundary — see that file for the canonical version this must stay in
 * sync with.
 *
 * Only `getMemoryDir` is implemented — `getMemoryEntrypoint`/`isMemoryPath`
 * aren't reachable from `subagentLoop.ts`'s call path (verified: it only
 * calls `scanMemoryFiles`/`loadMemoryIndex`, both of which only need
 * `getMemoryDir`), so they're intentionally omitted rather than
 * speculatively duplicated.
 */
import { resolveHomeDir } from '../bootstrap';

const MAX_SANITIZED_LENGTH = 200;

// joinPath/normalizeSeparators copied verbatim from src/utils/pathUtils.ts
// rather than imported: that module ALSO has an unrelated function
// (ensureParentDir) with a dynamic `await import('@tauri-apps/plugin-fs')`
// — esbuild doesn't tree-shake it away just because this shim only uses
// two of its exports, so importing the real module here would drag the
// whole file (and its Tauri leaf) into the bundle. These two functions are
// tiny and pure; inlining avoids a whole extra SHIM_TARGETS entry for a
// two-line dependency.
function normalizeSeparators(p: string): string {
  return p.replace(/\\/g, '/');
}

export function joinPath(...segments: string[]): string {
  return segments
    .map((s) => normalizeSeparators(s))
    .join('/')
    .replace(/\/{2,}/g, '/');
}

function djb2Hash(s: string): number {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  }
  return hash;
}

/** Verbatim copy of paths.ts's sanitizePath — must stay byte-identical. */
export function sanitizePath(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= MAX_SANITIZED_LENGTH) {
    return sanitized;
  }
  const hash = Math.abs(djb2Hash(name)).toString(36);
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${hash}`;
}

export async function getMemoryDir(workspacePath?: string | null): Promise<string> {
  const home = resolveHomeDir();
  if (workspacePath) {
    const normalized = normalizeSeparators(workspacePath);
    const key = sanitizePath(normalized);
    return joinPath(home, '.abu', 'projects', key, 'memory');
  }
  return joinPath(home, '.abu', 'memory');
}
