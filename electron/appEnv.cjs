/**
 * Resolve the sidecar entry path + bootstrap env for the Electron shell.
 * Shared by electron/main.cjs (dev shell) and electron/acceptance.cjs (test).
 *
 * In dev the sidecar bundle lives at <repo>/sidecar/index.mjs (built by
 * `npm run build:sidecar`); electron/ is a top-level sibling of it. In a
 * packaged app this would resolve under the app resources instead — out of
 * scope for slice 1 (dev only), noted for the packaging slice.
 *
 * The two env vars mirror what sidecarManager.ts passes on the Tauri side —
 * sidecar/src/bootstrap.ts reads them synchronously from process.env on its
 * first line (appDataDir depends on bundle identity, resourceDir on
 * dev-vs-packaged resolution — neither is derivable by a plain Node process):
 *   - ABU_APP_DATA_DIR: a writable per-app data dir. Kept DISTINCT from the
 *     Tauri dev app's `com.abu.app.dev` so the two shells never share state
 *     during the coexistence period.
 *   - ABU_RESOURCE_DIR: the dir that contains `sidecar/` (repo root in dev).
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const REPO_ROOT = path.resolve(__dirname, '..');
// Dev sidecar path (repo layout). The packaged path is resolved per-app via
// resourceRoot(app) — see below.
const SIDECAR_PATH = path.join(REPO_ROOT, 'sidecar', 'index.mjs');

/**
 * The directory that holds bundled resources (sidecar/, builtin-skills/, …).
 *  - Packaged: electron-builder puts extraResources under process.resourcesPath
 *    (Abu.app/Contents/Resources/), so that's the resource root.
 *  - Dev: the repo root (electron/ is a sibling of sidecar/).
 * `app` may be undefined in a plain-Node context (e.g. a test harness); default
 * to the dev repo root then.
 * @param {import('electron').App} [app]
 */
function resourceRoot(app) {
  return app && app.isPackaged ? process.resourcesPath : REPO_ROOT;
}

/** Absolute path to the sidecar bundle for the current (dev|packaged) layout. */
function sidecarPathFor(app) {
  return path.join(resourceRoot(app), 'sidecar', 'index.mjs');
}

/**
 * Canonical Electron-shell app-data dir, shared by the sidecar launch env
 * (ABU_APP_DATA_DIR) and the renderer-facing Tauri path/fs handlers
 * (tauriHost.cjs) so both sides agree on where app data lives.
 *  - Dev: `com.abu.app.electron-dev` — DISTINCT from the Tauri dev app's
 *    `com.abu.app.dev` so the two shells never share state while coexisting.
 *  - Packaged: `com.abu.app.electron` — still distinct from the Tauri PROD
 *    app's `com.abu.app` for now (the unsigned test builds must not touch real
 *    user data). The final signed release switches this to `com.abu.app` and
 *    runs the store-migration step (docs/2026-07-22-phase2-sliceC-secret-
 *    migration-plan.md + the conversation-dir migration).
 * @param {import('electron').App} app
 */
function abuAppDataDir(app) {
  const folder = app && app.isPackaged ? 'com.abu.app.electron' : 'com.abu.app.electron-dev';
  return path.join(app.getPath('appData'), folder);
}

/** @param {import('electron').App} app */
function resolveSidecarLaunch(app) {
  const dir = abuAppDataDir(app);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* best-effort; sidecar bootstrap tolerates absence for slice-1 methods */
  }
  return {
    sidecarPath: sidecarPathFor(app),
    electronPath: process.execPath,
    env: {
      ABU_APP_DATA_DIR: dir,
      ABU_RESOURCE_DIR: resourceRoot(app),
    },
  };
}

/** @param {import('electron').App} [app] */
function sidecarBundleExists(app) {
  return fs.existsSync(sidecarPathFor(app));
}

module.exports = {
  resolveSidecarLaunch,
  sidecarBundleExists,
  abuAppDataDir,
  sidecarPathFor,
  resourceRoot,
  SIDECAR_PATH,
  REPO_ROOT,
};
