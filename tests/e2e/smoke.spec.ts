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
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ElectronApplication, Page } from 'playwright';
import {
  closeAbuElectron,
  createElectronDataRoot,
  launchAbuElectron,
  removeElectronDataRoot,
  REPO_ROOT,
  type ElectronDataRoot,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;
const SCREENSHOT_PATH = path.join(REPO_ROOT, 'test-results', 'e2e-welcome.png');

const WELCOME_TITLE = '交给阿布就行啦';
const CHAT_PLACEHOLDER = '想让阿布帮你做点什么？';
const NEW_TASK_BUTTON = '新建任务';
const QUICK_START_TITLE = '快速入门';

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

  // A genuinely fresh profile opens the quick-start guide after Zustand
  // hydration. Dismiss it through its supported Escape behavior before tests
  // interact with the underlying welcome UI. Existing profiles skip this.
  const quickStart = page.getByText(QUICK_START_TITLE, { exact: true });
  await quickStart.waitFor({ state: 'visible', timeout: 1_500 }).catch(() => {});
  if (await quickStart.isVisible()) {
    await page.keyboard.press('Escape');
    await expect(quickStart).toBeHidden();
  }
}

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;

test.describe.serial('Electron shell — real app smoke', () => {
  test.afterEach(async () => {
    if (app) {
      await closeAbuElectron(app);
      app = undefined;
    }
    if (dataRoot) {
      removeElectronDataRoot(dataRoot);
      dataRoot = undefined;
    }
  });

  test('app-launches-and-renders', async () => {
    const launched = await launchAbuElectron();
    app = launched.app;
    dataRoot = launched;

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
    dataRoot = launched;

    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForWelcomeScreen(page);

    await expect(page.getByRole('button', { name: NEW_TASK_BUTTON }).first()).toBeVisible({
      timeout: READY_TIMEOUT,
    });
  });

  test('new-task-keeps-draft-in-chat-input', async () => {
    const launched = await launchAbuElectron();
    app = launched.app;
    dataRoot = launched;

    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForWelcomeScreen(page);

    await page.getByRole('button', { name: NEW_TASK_BUTTON }).first().click();
    const draft = `electron-e2e-draft-${randomUUID()}`;
    const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
    await input.fill(draft);
    await expect(input).toHaveValue(draft);
  });

  test('bridge-persists-app-data-across-restart', async () => {
    dataRoot = createElectronDataRoot();
    const firstLaunch = await launchAbuElectron(dataRoot);
    app = firstLaunch.app;

    const firstPage = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForWelcomeScreen(firstPage);

    const fileName = `electron-e2e-persistence-${randomUUID()}.txt`;
    const content = `electron e2e persistence ${randomUUID()}`;
    const reportedAppDataDir = await firstPage.evaluate(async ({ fileName, content }) => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const appDataDir = await invoke('plugin:path|resolve_directory', { directory: 14 });
      await invoke('plugin:fs|write_text_file', new TextEncoder().encode(content), {
        headers: {
          path: encodeURIComponent(fileName),
          options: JSON.stringify({ baseDir: 14 }),
        },
      });
      return appDataDir as string;
    }, { fileName, content });

    const relativeAppDataDir = path.relative(dataRoot.appDataDir, reportedAppDataDir);
    expect(relativeAppDataDir).not.toBe('');
    expect(relativeAppDataDir.startsWith(`..${path.sep}`) || path.isAbsolute(relativeAppDataDir)).toBe(false);

    await closeAbuElectron(app);
    app = undefined;

    const secondLaunch = await launchAbuElectron(dataRoot);
    app = secondLaunch.app;
    const secondPage = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForWelcomeScreen(secondPage);

    const readBack = await secondPage.evaluate(async (fileName) => {
      const bytes = await window.__TAURI_INTERNALS__.invoke('plugin:fs|read_text_file', {
        path: fileName,
        options: { baseDir: 14 },
      });
      return new TextDecoder().decode(new Uint8Array(bytes as ArrayLike<number>));
    }, fileName);
    expect(readBack).toBe(content);
  });
});
