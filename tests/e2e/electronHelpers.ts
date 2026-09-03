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
import { expect } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';

/**
 * Repo root. The npm script (`test:e2e:electron`) always invokes `playwright
 * test` from the repo root, so `process.cwd()` is reliable here — avoids the
 * __dirname-under-ESM footgun (package.json has `"type": "module"`).
 */
export const REPO_ROOT = process.cwd();
export const MAIN_ENTRY = path.join(REPO_ROOT, 'electron', 'main.cjs');
const E2E_APP_DATA_ROOT_ENV = 'ABU_E2E_APP_DATA_ROOT';
const E2E_SIDECAR_CRASH_TOKEN_ENV = 'ABU_E2E_SIDECAR_CRASH_TOKEN';
const SIDECAR_ID = 'abu-sidecar';
const READY_TIMEOUT = 45_000;
const CHAT_PLACEHOLDER = '想让阿布帮你做点什么？';

export interface ElectronDataRoot {
  rootDir: string;
  userDataDir: string;
  appDataDir: string;
  sidecarCrashToken: string;
}

export interface LaunchedApp extends ElectronDataRoot {
  app: ElectronApplication;
}

/**
 * Create a unique root that contains the Chromium profile and Electron appData
 * parent separately. Keep this root alive until the test has finished every
 * launch that needs it; a persistence test can pass it to launchAbuElectron()
 * again after closing its first app instance.
 */
export function createElectronDataRoot(): ElectronDataRoot {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), `abu-e2e-${randomUUID().slice(0, 8)}-`));
  return {
    rootDir,
    userDataDir: path.join(rootDir, 'user-data'),
    appDataDir: path.join(rootDir, 'app-data'),
    sidecarCrashToken: randomUUID(),
  };
}

/** Best-effort cleanup after a test has completed all launches using this root. */
export function removeElectronDataRoot(dataRoot: ElectronDataRoot): void {
  try {
    fs.rmSync(dataRoot.rootDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup only
  }
}

/**
 * Child env for the Electron launch. Starts from process.env, then strips
 * every `*_proxy` / `*_PROXY` variable and pins NO_PROXY to loopback, keeping
 * the launch hermetic against the developer shell's proxy state: the suite
 * only ever talks to per-test localhost mock servers, so no spec legitimately
 * needs a proxy, while a shell `http_proxy` (e.g. a local Clash on
 * 127.0.0.1:7897) was observed on 2026-08-30 to stall the sidecar's loopback
 * SSE stream until the 90s test timeout. Stripping (rather than only setting
 * NO_PROXY) also covers HTTP clients that honor `http_proxy` but not
 * `no_proxy`. CI runners set no proxy vars, so this is a no-op there.
 */
function buildLaunchEnv(dataRoot: ElectronDataRoot): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/_proxy$/i.test(key)) delete env[key];
  }
  env.NO_PROXY = '127.0.0.1,localhost';
  env.no_proxy = '127.0.0.1,localhost';
  env[E2E_APP_DATA_ROOT_ENV] = dataRoot.appDataDir;
  env[E2E_SIDECAR_CRASH_TOKEN_ENV] = dataRoot.sidecarCrashToken;
  // Native modal dialogs cannot be driven by Playwright. On hosts where
  // the OS grants Computer Use permissions (hosted CI runners), the CU
  // approval prompts would block a headless run forever — this makes them
  // auto-DECLINE (fail-closed; see tauriHost.cjs).
  env.ABU_E2E_DECLINE_CU_APPROVALS = '1';
  return env;
}

/**
 * Launch electron/main.cjs with fully isolated Chromium userData and appData.
 *
 * `--lang=zh-CN` pins the renderer's `navigator.language` (and therefore the
 * i18n system's resolved locale — see src/i18n/index.ts detectSystemLocale)
 * to zh-CN regardless of the host OS language. The suite asserts the zh-CN
 * UI; without this, an English-locale host (hosted CI runners, contributors'
 * machines) renders the en-US UI and every Chinese-text locator times out.
 *
 * main.cjs calls `app.requestSingleInstanceLock()`; if a second instance's
 * lock loses the race against an already-running instance sharing the same
 * userData dir, it calls `app.quit()` and NO window is ever created. Chromium/
 * Electron honors `--user-data-dir` as a full override of the userData path
 * (independent of `app.setName('abu-electron-dev')`), so a fresh temp dir per
 * test data root guarantees this test always wins the lock, and Chromium-profile-backed
 * state (localStorage — the `abu-settings` store, onboarding/disclaimer flags)
 * starts fresh every run.
 *
 * main.cjs reads ABU_E2E_APP_DATA_ROOT before app readiness and uses it only
 * for non-packaged builds, so the renderer-facing appData subfolder and any
 * Electron service using app.getPath('appData') remain inside this same root.
 */
export async function launchAbuElectron(dataRoot = createElectronDataRoot()): Promise<LaunchedApp> {
  fs.mkdirSync(dataRoot.userDataDir, { recursive: true });
  fs.mkdirSync(dataRoot.appDataDir, { recursive: true });
  const app = await electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${dataRoot.userDataDir}`, '--lang=zh-CN'],
    cwd: REPO_ROOT,
    env: buildLaunchEnv(dataRoot),
    timeout: 60_000,
  });
  // Spread FIRST: a caller relaunching with a previous LaunchedApp (which the
  // doc above invites, and which already carries an `app` key) would otherwise
  // have the stale, already-exited app spread over the new one — producing an
  // ElectronApplication whose process() throws and a firstWindow() that hangs
  // until timeout.
  return { ...dataRoot, app };
}

async function reloadAndWaitForApp(page: Page): Promise<void> {
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
}

/** Persist the common first-run acknowledgements used by Electron E2E journeys. */
export async function dismissFirstRunOverlays(page: Page): Promise<void> {
  await page.evaluate(() => {
    const raw = window.localStorage.getItem('abu-settings');
    if (!raw) throw new Error('abu-settings was not initialized before E2E configuration');
    const persisted = JSON.parse(raw) as { state: Record<string, unknown>; version: number };
    Object.assign(persisted.state, {
      guideShown: true,
      guideOpen: false,
      hasAcknowledgedDisclaimer: true,
      hasRunSensitiveAudit_v015: true,
    });
    window.localStorage.setItem('abu-settings', JSON.stringify(persisted));
  });
  await reloadAndWaitForApp(page);
}

export interface LocalMockProviderOptions {
  apiKey?: string;
  contextWindowSize?: number;
  maxOutputTokens?: number;
  modelId?: string;
  modelLabel?: string;
  permissionMode?: 'standard' | null;
  providerId?: string;
  providerName?: string;
  supportsReasoning?: boolean | null;
  supportsTools?: boolean;
}

/** Configure an isolated loopback provider while preserving each spec's metadata. */
export async function configureLocalMockProvider(
  page: Page,
  baseUrl: string,
  options: LocalMockProviderOptions = {},
): Promise<void> {
  const {
    apiKey = 'abu-e2e-test-key-not-a-real-secret',
    contextWindowSize,
    maxOutputTokens,
    modelId = 'abu-e2e-local-model',
    modelLabel = 'Abu E2E deterministic model',
    permissionMode = null,
    providerId = 'abu-e2e-local-provider',
    providerName = 'Abu E2E loopback mock',
    supportsReasoning = false,
    supportsTools = false,
  } = options;

  await page.evaluate((configuration) => {
    const raw = window.localStorage.getItem('abu-settings');
    if (!raw) throw new Error('abu-settings was not initialized before E2E configuration');
    const persisted = JSON.parse(raw) as { state: Record<string, unknown>; version: number };
    const state = persisted.state;
    const declaredCapabilities = configuration.supportsReasoning === null
      ? { supportsTools: configuration.supportsTools }
      : {
          supportsReasoning: configuration.supportsReasoning,
          supportsTools: configuration.supportsTools,
        };

    state.providers = [{
      id: configuration.providerId,
      source: 'custom',
      name: configuration.providerName,
      enabled: true,
      apiFormat: 'openai-compatible',
      baseUrl: configuration.baseUrl,
      apiKey: configuration.apiKey,
      models: [{
        id: configuration.modelId,
        label: configuration.modelLabel,
        isCustom: true,
        declaredCapabilities,
      }],
      defaultModelId: configuration.modelId,
      status: 'verified',
      sortOrder: 0,
      userAdded: true,
      declaredCapabilities,
    }];
    state.activeModel = { providerId: configuration.providerId, modelId: configuration.modelId };
    state.recentModels = [];
    state.favoriteModels = [];
    state.guideShown = true;
    state.guideOpen = false;
    state.hasAcknowledgedDisclaimer = true;
    state.hasRunSensitiveAudit_v015 = true;
    if (configuration.permissionMode !== null) state.permissionMode = configuration.permissionMode;
    if (configuration.contextWindowSize !== undefined) state.contextWindowSize = configuration.contextWindowSize;
    if (configuration.maxOutputTokens !== undefined) state.maxOutputTokens = configuration.maxOutputTokens;

    window.localStorage.setItem('abu-settings', JSON.stringify({ ...persisted, state, version: 42 }));
  }, {
    apiKey,
    baseUrl,
    contextWindowSize,
    maxOutputTokens,
    modelId,
    modelLabel,
    permissionMode,
    providerId,
    providerName,
    supportsReasoning,
    supportsTools,
  });
  await reloadAndWaitForApp(page);
}

/**
 * Close the app while preserving its data root for a possible relaunch.
 *
 * No orphan sidecar to chase down here: the frontend spawns the sidecar via
 * mcp_spawn, routed to electron/mcpBridge.cjs, whose own `process.on('exit', ...)`
 * / SIGINT/SIGTERM/SIGHUP guards SIGKILL every child it spawned when the
 * Electron process itself exits (see mcpBridge.cjs "No orphans" section) — so
 * closing the Electron app here is sufficient, nothing extra to kill.
 */
export async function closeAbuElectron(app: ElectronApplication): Promise<void> {
  const child = app.process();

  // Ask Electron itself to quit so main.cjs's before-quit path tears down
  // browser views, PTYs, helpers, and sidecars. ElectronApplication.close()
  // can otherwise close the BrowserWindow first; Abu's preventable
  // close-request handler may intentionally keep that window alive.
  try {
    await app.evaluate(({ app: electronApp }) => {
      electronApp.quit();
    });
  } catch {
    // The transport commonly closes before evaluate receives its result.
  }
  if (await waitForChildExit(child, 5_000)) return;

  // Bounded fallback for a broken teardown. Signals target only Playwright's
  // exact child process, never a name/pattern that could match a user app.
  child.kill('SIGTERM');
  if (await waitForChildExit(child, 3_000)) return;
  child.kill('SIGKILL');
  await waitForChildExit(child, 2_000);
}

/**
 * Terminate the exact Electron process without running the renderer's graceful
 * shutdown path. The main process still receives SIGTERM, so its no-orphan
 * guards kill the sidecar and other child processes before exiting.
 */
export async function terminateAbuElectron(app: ElectronApplication): Promise<void> {
  const child = app.process();
  child.kill('SIGTERM');
  if (await waitForChildExit(child, 5_000)) return;
  child.kill('SIGKILL');
  await waitForChildExit(child, 2_000);
}

/**
 * Ask the isolated E2E sidecar to terminate itself. The launch-specific token
 * is available only to this test and the child process; production launches
 * never enable the method. Self-termination avoids any external PID lookup or
 * PID-reuse window that could target an unrelated process.
 */
export async function crashAbuSidecarForE2E(page: Page, sidecarCrashToken: string): Promise<void> {
  await page.evaluate(async ({ id, token }) => {
    const internals = (
      window as Window & {
        __TAURI_INTERNALS__?: {
          invoke: (command: string, args?: unknown) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;
    if (!internals) throw new Error('Electron IPC bridge is unavailable');
    await internals.invoke('mcp_write', {
      id,
      message: JSON.stringify({
        jsonrpc: '2.0',
        method: 'e2e.crash',
        params: { token },
      }),
    });
  }, { id: SIDECAR_ID, token: sidecarCrashToken });
}

function waitForChildExit(
  child: ReturnType<ElectronApplication['process']>,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

/**
 * Resolve the OS drag region at a viewport point, the way Chromium actually
 * builds it: walk the layout tree in DOCUMENT order, unioning `drag` rects and
 * subtracting `no-drag` ones. The LAST writer covering the point wins —
 * stacking order (`z-index`, `elementsFromPoint`) does NOT decide it.
 *
 * Modelling this with `elementsFromPoint` instead shipped a real regression:
 * the floating macOS window controls sit earlier in the DOM than the cards, so
 * a card's own drag row unioned straight back over them and killed their
 * clicks, while a stacking-order test reported them healthy.
 */
export async function appRegionAt(page: Page, x: number, y: number): Promise<string> {
  return page.evaluate(({ px, py }) => {
    let state = 'none';
    for (const element of document.querySelectorAll('*')) {
      const region = getComputedStyle(element).webkitAppRegion;
      if (region !== 'drag' && region !== 'no-drag') continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (px < rect.left || px > rect.right || py < rect.top || py > rect.bottom) continue;
      state = region;
    }
    return state;
  }, { px: x, py: y });
}
