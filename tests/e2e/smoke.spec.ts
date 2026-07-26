/**
 * Real-Electron-app E2E smoke suite.
 *
 * Launches the ACTUAL built app (`electron/main.cjs` loading
 * `dist-electron-spike/index.html`, real preload + sidecar wiring) via
 * Playwright's `_electron` API and drives the real renderer window — true
 * end-to-end, not one of the headless IPC harnesses under `electron/spike/`.
 *
 * OUT OF SCOPE: OS-native chrome (tray icon, dock, menubar, macOS traffic
 * lights) — Playwright only sees the web content inside the BrowserWindow,
 * it cannot assert on native OS UI. That coverage gap is intentional here;
 * `electron/spike/f8GuiVerify.cjs` is the (separate, non-Playwright) attempt
 * at that and is itself skipped unattended (needs a real display).
 */
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { ElectronApplication, Page } from 'playwright';
import { closeAbuElectron, launchAbuElectron, REPO_ROOT } from './electronHelpers';

const READY_TIMEOUT = 45_000;
const SCREENSHOT_PATH = path.join(REPO_ROOT, 'test-reports', 'e2e-welcome.png');

const WELCOME_TITLE = '交给阿布就行啦';
const CHAT_PLACEHOLDER = '想让阿布帮你做点什么？';
const NEW_TASK_BUTTON = '新建任务';

/**
 * Wait until the real welcome screen is up: either the hero title or the
 * chat input placeholder proves the React app actually mounted real content
 * (not a blank window / the preload error page / a stuck loading screen).
 * `.first()` sidesteps a strict-mode violation in case the title text also
 * appears in an ancestor's accessible text.
 */
async function waitForWelcomeScreen(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  const ready = page.getByText(WELCOME_TITLE).or(page.getByPlaceholder(CHAT_PLACEHOLDER)).first();
  await expect(ready).toBeVisible({ timeout: READY_TIMEOUT });
}

let app: ElectronApplication | undefined;
let userDataDir: string | undefined;

test.describe.serial('Electron shell — real app smoke', () => {
  test.afterEach(async () => {
    if (app) {
      await closeAbuElectron(app, userDataDir);
      app = undefined;
      userDataDir = undefined;
    }
  });

  test('app-launches-and-renders', async () => {
    const launched = await launchAbuElectron();
    app = launched.app;
    userDataDir = launched.userDataDir;

    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForWelcomeScreen(page);

    // Belt-and-suspenders: the title text must actually be visible, not just
    // matched by a loose locator.
    await expect(page.getByText(WELCOME_TITLE).first()).toBeVisible({ timeout: READY_TIMEOUT });

    fs.mkdirSync(path.dirname(SCREENSHOT_PATH), { recursive: true });
    await page.screenshot({ path: SCREENSHOT_PATH });
  });

  test('sidebar-present', async () => {
    const launched = await launchAbuElectron();
    app = launched.app;
    userDataDir = launched.userDataDir;

    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForWelcomeScreen(page);

    await expect(page.getByRole('button', { name: NEW_TASK_BUTTON }).first()).toBeVisible({
      timeout: READY_TIMEOUT,
    });
  });
});
