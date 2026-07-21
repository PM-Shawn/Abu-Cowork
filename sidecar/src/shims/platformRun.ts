/**
 * Sidecar-local replacement for `src/utils/platform.ts`.
 *
 * REAL behavior shim — the real module's `initPlatform()` resolves Tauri's
 * `platform()` API asynchronously and caches the result for the sync
 * `isWindows()`/`getPlatform()` reads that follow; the sidecar is a plain
 * Node process, so `node:os.platform()` is a same-machine, synchronous
 * equivalent — no async init needed at all. Mapping: `win32` → `windows`,
 * `darwin` → `macos`, everything else → `linux` (matches the real module's
 * three-way `Platform` union).
 *
 * `getShell()` added for P1-3d-5 slice 2b (`commandTools.ts`'s `run_command`,
 * for its description-string interpolation only — never used for actual
 * shell selection, the real spawn happens shell-side via
 * `invoke('run_shell_command')`): pure lookup on the already-resolved
 * `current` platform, same mapping as the real module's `getShell()`
 * (`windows` → `'PowerShell'`, everything else → `'zsh/bash'`).
 */
import { platform } from 'node:os';

export type Platform = 'windows' | 'macos' | 'linux';

function resolvePlatform(): Platform {
  const p = platform();
  if (p === 'win32') return 'windows';
  if (p === 'darwin') return 'macos';
  return 'linux';
}

const current: Platform = resolvePlatform();

/** No-op — resolved synchronously above; kept for call-site compatibility (the real module's callers `await initPlatform()` once at startup). */
export async function initPlatform(): Promise<void> {
  return Promise.resolve();
}

export function getPlatform(): Platform {
  return current;
}

export function isWindows(): boolean {
  return current === 'windows';
}

export function isMacOS(): boolean {
  return current === 'macos';
}

export function isLinux(): boolean {
  return current === 'linux';
}

export function getShell(): string {
  if (current === 'windows') return 'PowerShell';
  return 'zsh/bash';
}
