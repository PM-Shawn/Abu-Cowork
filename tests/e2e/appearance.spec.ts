import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import {
  closeAbuElectron,
  dismissFirstRunOverlays,
  launchAbuElectron,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;
const CHAT_PLACEHOLDER = '想让阿布帮你做点什么？';
// A nickname written into the earlier profile; the account button carries it once it is stored.
const KEPT_NAME = 'e2e-kept-name';

type Appearance = 'light' | 'dark';

interface StoredAppearance {
  version: number;
  theme: string;
}

function storedAppearance(page: Page): Promise<StoredAppearance> {
  return page.evaluate(() => {
    const persisted = JSON.parse(localStorage.getItem('abu-settings')!) as { version: number; state: { theme: string } };
    return { version: persisted.version, theme: persisted.state.theme };
  });
}

function pageIsDark(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.classList.contains('dark'));
}

// The appearance of the system is what Electron's `nativeTheme` reports to the page. Playwright
// launches every page with `prefers-color-scheme` held on light, so that hold is lifted first. A
// page that follows the system hands the window theme back to the system when it mounts, through
// a call to the main process; a value set here before that call lands is overwritten. So the value
// is set again on every look until the page reports it.
async function systemBecomes(app: ElectronApplication, page: Page, appearance: Appearance): Promise<void> {
  await page.emulateMedia({ colorScheme: null });
  await expect.poll(async () => {
    await app.evaluate(({ nativeTheme }, source) => { nativeTheme.themeSource = source; }, appearance);
    return page.evaluate(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  }).toBe(appearance === 'dark');
}

// Records whether <html> is dark when the document has been parsed and no module script has run
// yet: after the blocking script of index.html, before the app.
async function recordFirstPaint(page: Page): Promise<void> {
  await page.addInitScript(() => {
    document.addEventListener('readystatechange', () => {
      if (document.readyState !== 'interactive') return;
      (window as unknown as { __abuFirstPaintDark?: boolean }).__abuFirstPaintDark = document.documentElement.classList.contains('dark');
    });
  });
}

function firstPaintWasDark(page: Page): Promise<boolean | undefined> {
  return page.evaluate(() => (window as unknown as { __abuFirstPaintDark?: boolean }).__abuFirstPaintDark);
}

async function reloadApp(page: Page): Promise<void> {
  await page.reload();
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
}

async function openPreferences(page: Page): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`^(我|登录 / 注册|${KEPT_NAME})$`) }).first().click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await page.locator('[data-abu-settings-dialog]').getByRole('button', { name: '偏好', exact: true }).click();
  await expect(page.getByRole('radio', { name: '跟随系统', exact: true })).toBeVisible();
}

async function closeSettings(page: Page): Promise<void> {
  await page.locator('[data-abu-settings-close]').click();
  await expect(page.locator('[data-abu-settings-dialog]')).toHaveCount(0);
}

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;

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

test('a new profile stores 跟随系统 and follows the system while it runs, a reload with it stored paints a dark system dark first, and a chosen appearance stays', async () => {
  const launched = await launchAbuElectron();
  app = launched.app;
  dataRoot = launched;
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
  await dismissFirstRunOverlays(page);

  expect((await storedAppearance(page)).theme).toBe('system');

  // The page follows the system while it runs.
  await systemBecomes(app, page, 'dark');
  await expect.poll(() => pageIsDark(page)).toBe(true);
  await systemBecomes(app, page, 'light');
  await expect.poll(() => pageIsDark(page)).toBe(false);

  // A dark system is dark from the first paint.
  await recordFirstPaint(page);
  await systemBecomes(app, page, 'dark');
  await reloadApp(page);
  expect(await firstPaintWasDark(page)).toBe(true);

  await openPreferences(page);
  const choices = page.getByRole('group', { name: '外观' }).getByRole('radio');
  await expect(choices).toHaveText(['跟随系统', '浅色', '深色']);
  await expect(page.getByRole('radio', { name: '跟随系统', exact: true })).toHaveAttribute('aria-checked', 'true');

  // A chosen appearance no longer follows the system.
  await page.getByRole('radio', { name: '浅色', exact: true }).click();
  await expect.poll(async () => (await storedAppearance(page)).theme).toBe('light');
  await systemBecomes(app, page, 'dark');
  expect(await pageIsDark(page)).toBe(false);
  await closeSettings(page);
  await reloadApp(page);
  expect(await firstPaintWasDark(page)).toBe(false);
  expect(await pageIsDark(page)).toBe(false);
});

test('settings saved by an earlier version follow the system once, and a later choice survives a restart', async () => {
  const launched = await launchAbuElectron();
  app = launched.app;
  dataRoot = launched;
  let page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
  await dismissFirstRunOverlays(page);
  const current = await storedAppearance(page);

  // The profile as the version before this one left it: the light appearance, stamped one version back.
  await recordFirstPaint(page);
  await systemBecomes(app, page, 'dark');
  await Promise.all([page.waitForEvent('load'), page.evaluate(async ({ earlier, name }) => {
    await navigator.locks.request('abu-browser-permission-config-v2', () => {
      const persisted = JSON.parse(window.localStorage.getItem('abu-settings')!) as { state: Record<string, unknown>; version: number };
      persisted.version = earlier;
      Object.assign(persisted.state, { theme: 'light', userNickname: name });
      window.localStorage.setItem('abu-settings', JSON.stringify(persisted));
      window.location.reload();
    });
  }, { earlier: current.version - 1, name: KEPT_NAME })]);
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });

  // Dark from the first paint, before the stored value has been migrated.
  expect(await firstPaintWasDark(page)).toBe(true);
  await expect.poll(() => storedAppearance(page)).toEqual({ version: current.version, theme: 'system' });
  const kept = await page.evaluate(() => {
    const state = (JSON.parse(localStorage.getItem('abu-settings')!) as { state: Record<string, unknown> }).state;
    return [state.userNickname, state.guideShown, state.hasAcknowledgedDisclaimer];
  });
  expect(kept).toEqual([KEPT_NAME, true, true]);
  await systemBecomes(app, page, 'dark');
  await expect.poll(() => pageIsDark(page)).toBe(true);

  await openPreferences(page);
  await expect(page.getByRole('radio', { name: '跟随系统', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('radio', { name: '浅色', exact: true }).click();
  await expect.poll(async () => (await storedAppearance(page)).theme).toBe('light');
  await expect.poll(() => pageIsDark(page)).toBe(false);

  await closeAbuElectron(app);
  app = undefined;
  app = (await launchAbuElectron(dataRoot)).app;
  page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });

  expect(await storedAppearance(page)).toEqual({ version: current.version, theme: 'light' });
  await systemBecomes(app, page, 'dark');
  expect(await pageIsDark(page)).toBe(false);
  await openPreferences(page);
  await expect(page.getByRole('radio', { name: '浅色', exact: true })).toHaveAttribute('aria-checked', 'true');
});
