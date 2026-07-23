/**
 * Helpers for the real-Electron-app E2E smoke suite (tests/e2e/smoke.spec.ts).
 *
 * These launch the ACTUAL `electron/main.cjs` entry point via Playwright's
 * `_electron` API — the same code path as `npm run electron:dev` — not a
 * headless IPC harness. See electron/main.cjs for the full launch story.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication } from 'playwright';

/**
 * Repo root. The npm script (`test:e2e:electron`) always invokes `playwright
 * test` from the repo root, so `process.cwd()` is reliable here — avoids the
 * __dirname-under-ESM footgun (package.json has `"type": "module"`).
 */
export const REPO_ROOT = process.cwd();
export const MAIN_ENTRY = path.join(REPO_ROOT, 'electron', 'main.cjs');

export interface LaunchedApp {
  app: ElectronApplication;
  userDataDir: string;
}

/**
 * Launch electron/main.cjs with an ISOLATED --user-data-dir.
 *
 * main.cjs calls `app.requestSingleInstanceLock()`; if a second instance's
 * lock loses the race against an already-running instance sharing the same
 * userData dir, it calls `app.quit()` and NO window is ever created. Chromium/
 * Electron honors `--user-data-dir` as a full override of the userData path
 * (independent of `app.setName('abu-electron-dev')`), so a fresh temp dir per
 * launch guarantees this test always wins the lock, and Chromium-profile-backed
 * state (localStorage — the `abu-settings` store, onboarding/disclaimer flags)
 * starts fresh every run.
 *
 * NOTE — partial isolation only: the frontend's own app data (chat history,
 * catalog db) lives under `app.getPath('appData')` + a FIXED subfolder
 * (`com.abu.app.electron-dev`, set in electron/appEnv.cjs `abuAppDataDir`),
 * which is NOT affected by `--user-data-dir` — it is shared across every
 * electron-dev launch on the machine (same as `npm run electron:dev`). So the
 * welcome screen may show pre-existing conversations from earlier dev-shell
 * runs; this is expected and does not affect this suite's assertions (which
 * only check the always-present welcome UI, not conversation content). It is
 * still fully separate from the real Tauri prod (`com.abu.app`) and Tauri-dev
 * (`com.abu.app.dev`) data directories.
 */
export async function launchAbuElectron(): Promise<LaunchedApp> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `abu-e2e-${randomUUID().slice(0, 8)}-`));
  const app = await electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    cwd: REPO_ROOT,
    timeout: 60_000,
  });
  return { app, userDataDir };
}

/**
 * Close the app and best-effort clean up its temp userData dir.
 *
 * No orphan sidecar to chase down here: the frontend spawns the sidecar via
 * mcp_spawn, routed to electron/mcpBridge.cjs, whose own `process.on('exit', ...)`
 * / SIGINT/SIGTERM/SIGHUP guards SIGKILL every child it spawned when the
 * Electron process itself exits (see mcpBridge.cjs "No orphans" section) — so
 * closing the Electron app here is sufficient, nothing extra to kill.
 */
export async function closeAbuElectron(app: ElectronApplication, userDataDir?: string): Promise<void> {
  try {
    await app.close();
  } catch {
    // already closed / crashed mid-test — nothing more to do
  }
  if (userDataDir) {
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup only
    }
  }
}
