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
const SIDECAR_PATH = path.join(REPO_ROOT, 'sidecar', 'index.mjs');

/** @param {import('electron').App} app */
function resolveSidecarLaunch(app) {
  const appDataRoot = app.getPath('appData');
  const abuAppDataDir = path.join(appDataRoot, 'com.abu.app.electron-dev');
  try {
    fs.mkdirSync(abuAppDataDir, { recursive: true });
  } catch {
    /* best-effort; sidecar bootstrap tolerates absence for slice-1 methods */
  }
  return {
    sidecarPath: SIDECAR_PATH,
    electronPath: process.execPath,
    env: {
      ABU_APP_DATA_DIR: abuAppDataDir,
      ABU_RESOURCE_DIR: REPO_ROOT,
    },
  };
}

function sidecarBundleExists() {
  return fs.existsSync(SIDECAR_PATH);
}

module.exports = { resolveSidecarLaunch, sidecarBundleExists, SIDECAR_PATH, REPO_ROOT };
