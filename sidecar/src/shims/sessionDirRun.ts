/**
 * Sidecar-local replacement for `src/core/session/sessionDir.ts`.
 *
 * OWN JUDGMENT CALL (item 9 in this batch's brief explicitly allows building
 * a small targeted shim when the need is obvious and low-risk — flagged as
 * such). This is NOT a Tauri-fs-import problem (`exists`/`mkdir`/
 * `appDataDir` are all already real, working shims — see `pluginFsRun.ts`/
 * `tauriPathRun.ts`) — it's a BEHAVIOR problem in the real module's OWN
 * logic: `getSessionOutputDir()` starts with `if (!isTauriEnv()) return
 * null;`. `src/utils/tauriEnv.ts`'s `isTauriEnv()` is `typeof window !==
 * 'undefined' && !!window.__TAURI_INTERNALS__` — in a Node sidecar process,
 * `window` is always `undefined`, so this check ALWAYS evaluates `false`
 * there, meaning the REAL module (bundled as-is) would make
 * `getSessionOutputDir()` unconditionally return `null` inside the sidecar
 * — silently disabling `agentLoop.ts`'s `saveUserImagesToDisk()` (pasted
 * images would never persist to disk for a sidecar-run main loop) even
 * though the fs/path calls underneath it work perfectly fine via the real
 * shims. This is exactly the "silent behavior gap the import-graph audit
 * alone would miss" class of bug (the file's IMPORTS are 100% clean/pure —
 * only Tauri fs/path, both shimmed — so a purity-only check would have
 * wrongly marked this file "clean, no shim needed").
 *
 * The fix: reimplement `getSessionOutputDir` WITHOUT the `isTauriEnv()`
 * gate (the sidecar only ever runs as part of the desktop Tauri app, so the
 * "are we in a real desktop build" question this check exists to answer is
 * always "yes" for a sidecar process by construction — there is no
 * web/E2E-mode equivalent of "sidecar process exists but isn't part of a
 * real Abu desktop install"), reusing the ALREADY-REAL `exists`/`mkdir`
 * (`pluginFsRun.ts`) and `appDataDir` (`tauriPathRun.ts`) shims directly —
 * no fs logic duplicated.
 */
import { exists, mkdir } from './pluginFsRun';
import { appDataDir } from './tauriPathRun';
import { joinPath } from '@/utils/pathUtils';

let cachedBasePath: string | null = null;

export async function getSessionOutputDir(conversationId: string): Promise<string | null> {
  if (!cachedBasePath) {
    const appData = await appDataDir();
    cachedBasePath = joinPath(appData, 'conversations');
  }

  const outputDir = joinPath(cachedBasePath, conversationId, 'outputs');

  if (!(await exists(outputDir))) {
    await mkdir(outputDir, { recursive: true });
  }

  return outputDir;
}
