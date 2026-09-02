/**
 * Sidecar bootstrap data — the two Tauri-resolved directory paths that
 * CANNOT be derived inside a plain Node process (`appDataDir()` depends on
 * the app's bundle identifier/OS profile resolution; `resourceDir()`
 * depends on Tauri's dev-vs-packaged resource-bundle resolution). Both are
 * resolved SHELL-side (`src/core/sidecar/sidecarManager.ts`, which already
 * calls `@tauri-apps/api/path`'s `resolveResource('sidecar/index.mjs')` to
 * locate the entry script itself) and passed down as SPAWN-TIME ENVIRONMENT
 * VARIABLES on the child process — not a post-spawn notification.
 *
 * ── Why env vars, not a notification ─────────────────────────────────────
 * `sidecarManager.ts`'s `attemptSpawn()` already calls `invoke('mcp_spawn',
 * { id, command: 'node', args: [entryPath], env: {} })` — `env` is a plain
 * `HashMap<String,String>` the Rust side (`src-tauri/src/lib.rs`'s
 * `mcp_spawn`) applies via `cmd.env(k, v)` on the child process BEFORE it
 * starts (verified by reading that function, not assumed). This means the
 * two values are available in `process.env` from the very FIRST line of
 * this process's execution — no "arrived yet?" race at all, unlike a
 * post-spawn notification (which would need every path-resolution call site
 * to handle a "bootstrap hasn't arrived yet" state during the process's
 * early lifetime). Smallest-diff, and structurally race-free by
 * construction — chosen over a `bootstrap`-style notification for this
 * reason.
 *
 * ── Home (`ABU_HOME_DIR`, resolved by `resolveHomeDir()` below) ──────────
 * Home IS derivable in plain Node (`node:os.homedir()`), and that used to be
 * the whole story here. But the SHELL's home can legitimately differ from
 * the OS home: `electron/main.cjs`'s gated E2E block redirects
 * `app.getPath('home')` into the launch-scoped data root so isolated E2E
 * runs never read or write the developer's real `~/.abu` state (memdir
 * memories leaked into LLM requests otherwise — observed 2026-09-01). The
 * shell therefore also passes its own resolved `homeDir()` down as
 * `ABU_HOME_DIR`, so both processes compose identical `~/.abu/...` paths in
 * every mode. Unlike the two vars above this one is fail-SOFT at read time:
 * `os.homedir()` is a correct fallback (equal to the shell's value in every
 * non-redirected run), so a spawn that omitted the var keeps the exact
 * pre-existing behavior instead of throwing.
 *
 * ── Fail-loud discipline ──────────────────────────────────────────────────
 * If the shell failed to resolve `appDataDir()`/`resourceDir()` before
 * spawn (`sidecarManager.ts`'s own module doc requires every failure path
 * there to be fail-SOFT — log + omit the env var, never fail the spawn),
 * `getBootstrap()` throws a clear "not available" error the FIRST time
 * something actually needs the missing value — never silently returns an
 * empty string or a wrong path. Nothing in the sidecar's CURRENT role
 * requires these at process-start (this card is prep for P1-3B-3B), so a
 * spawn that omitted them causes no harm until a real caller (skill/loader,
 * session/sessionDir, etc.) actually needs one.
 *
 * ── Shell-side wiring needed (documented for the coordinator; NOT applied
 * by this file) ───────────────────────────────────────────────────────────
 * `src/core/sidecar/sidecarManager.ts`'s `attemptSpawn()`, right before the
 * `invoke('mcp_spawn', ...)` call, needs:
 * ```ts
 * import { appDataDir, resourceDir } from '@tauri-apps/api/path'; // add to existing import line
 * // ...
 * const env: Record<string, string> = {};
 * try { env.ABU_APP_DATA_DIR = await appDataDir(); }
 * catch (err) { logger.warn('Failed to resolve appDataDir for sidecar bootstrap', { error: err instanceof Error ? err.message : String(err) }); }
 * try { env.ABU_RESOURCE_DIR = await resourceDir(); }
 * catch (err) { logger.warn('Failed to resolve resourceDir for sidecar bootstrap', { error: err instanceof Error ? err.message : String(err) }); }
 * // then: await invoke('mcp_spawn', { id: SIDECAR_ID, command: 'node', args: [entryPath], env });
 * ```
 * No `main.ts` dispatch wiring is needed at all (unlike a notification-based
 * bootstrap) — `process.env` is read directly here, synchronously, with no
 * message-handler registration required.
 */

import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';

export interface SidecarBootstrap {
  appDataDir: string;
  resourceDir: string;
}

function readEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `[sidecar] bootstrap env var "${name}" is not set — src/core/sidecar/sidecarManager.ts's attemptSpawn() must resolve it (via @tauri-apps/api/path) and pass it in mcp_spawn's "env" option. Called before bootstrap data arrived, or the shell-side resolution failed — see bootstrap.ts's module doc for the exact wiring needed.`,
    );
  }
  return v;
}

let cached: SidecarBootstrap | undefined;

/** Resolve (and cache) the two Tauri-only directories passed down as spawn-time env vars. Throws — never returns a guessed/empty path — if either is missing. */
export function getBootstrap(): SidecarBootstrap {
  if (!cached) {
    cached = {
      appDataDir: readEnv('ABU_APP_DATA_DIR'),
      resourceDir: readEnv('ABU_RESOURCE_DIR'),
    };
  }
  return cached;
}

/**
 * The user home directory as the SHELL resolves it — `ABU_HOME_DIR` when the
 * spawn provided a usable (absolute) value, else `node:os.homedir()`. Every
 * sidecar-side `~/...` composition (memdir state in `shims/memdirPaths.ts`,
 * `shims/tauriPathRun.ts`'s `homeDir()`) MUST go through this so renderer and
 * sidecar resolve identical `~/.abu/...` paths even when the shell's home is
 * redirected (E2E isolation). A malformed value is ignored, not thrown on:
 * the fallback is exactly the pre-`ABU_HOME_DIR` behavior.
 */
export function resolveHomeDir(): string {
  const v = process.env.ABU_HOME_DIR;
  if (v && isAbsolute(v)) return v;
  return homedir();
}

/** Test-only reset. */
export function __resetBootstrapForTests(): void {
  cached = undefined;
}
