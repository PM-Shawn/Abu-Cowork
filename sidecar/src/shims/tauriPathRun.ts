/**
 * Sidecar-local replacement for `@tauri-apps/api/path`.
 *
 * REAL behavior shim — every function below resolves the SAME path on the
 * SAME machine the shell would (sidecar and webview are sibling processes
 * under one Tauri app instance, per `memdirPaths.ts`'s established
 * precedent), using `node:path`/`node:os` plus the two spawn-time bootstrap
 * values (`bootstrap.ts`) for the two Tauri-only directories.
 *
 * Export surface verified against every reachable importer, not guessed:
 * `grep -rln "@tauri-apps/api/path" src/core/session/{outputSnapshots,
 * sessionMemory,sessionDir}.ts src/core/skill/loader.ts` plus
 * `src/core/sidecar/sidecarManager.ts` (shell-side, not sidecar-reachable,
 * excluded) →
 *   - `homeDir` (outputSnapshots.ts, skill/loader.ts) — `node:os.homedir()`,
 *     same as `memdirPaths.ts`'s established pattern, copied not reinvented.
 *   - `appDataDir` (sessionDir.ts, sessionMemory.ts, outputSnapshots.ts,
 *     skill/loader.ts) — from `bootstrap.ts`'s `getBootstrap().appDataDir`.
 *   - `resolveResource` (skill/loader.ts, for the bundled `builtin-skills`
 *     dir) — `node:path.join(getBootstrap().resourceDir, resourcePath)`.
 *     Tauri's own `resolveResource(p)` is documented as resolving `p`
 *     relative to the app's resource directory (the same directory
 *     `resourceDir()` returns) — verified indirectly: `sidecarManager.ts`
 *     itself already calls `resolveResource('sidecar/index.mjs')` to find
 *     the sidecar's own entry script, and that entry script physically
 *     lives at `<resourceDir>/sidecar/index.mjs` in the packaged app
 *     layout, so a plain `path.join` reproduces the same resolution for any
 *     OTHER resource path too — no additional Tauri-side magic beyond
 *     directory concatenation is documented or exercised by any current
 *     caller.
 *   - `resolve` (skill/loader.ts, ONLY inside its dev-mode fallback branch,
 *     wrapped in try/catch — resolves a relative path against the current
 *     working directory) — `node:path.resolve(...)`, direct equivalent.
 *
 * Not exported (no reachable importer references them):
 * `appConfigDir`/`appLocalDataDir`/`cacheDir`/`configDir`/`documentDir`/
 * `join`/`normalize`/`dirname`/etc. — all the OTHER ~25 exports of the real
 * module. Adding them speculatively would be unverifiable dead code; a
 * future reachable import of one will fail loudly at `npm run build:sidecar`
 * time (missing export from this redirect target) rather than silently
 * resolving to `undefined`.
 */
import { homedir } from 'node:os';
import { resolve as nodeResolve, join as nodeJoin } from 'node:path';
import { getBootstrap } from '../bootstrap';

export async function homeDir(): Promise<string> {
  return homedir();
}

export async function appDataDir(): Promise<string> {
  return getBootstrap().appDataDir;
}

export async function resolveResource(resourcePath: string): Promise<string> {
  return nodeJoin(getBootstrap().resourceDir, resourcePath);
}

export async function resolve(...paths: string[]): Promise<string> {
  return nodeResolve(...paths);
}
