/**
 * S18 + S12 in a REAL Electron shell: change the master switch, restart the
 * app, and read it back — with the effective-permission preview following it.
 *
 * The reason this is an e2e test and not another unit test is the middle step.
 * 「不能只以 React 显示正确为验收」 is the PRD's own wording, and every layer
 * below this one can be green while the value never reaches disk: the store
 * updates, the component re-renders, and a real relaunch shows the old
 * permission. Nothing short of a genuine second launch of the same profile can
 * tell those two apart.
 *
 * The preview rides along for the same reason. It is supposed to report what
 * the gate will actually do, so a switch that has really persisted must move it
 * — a preview that stayed on 「拒绝」 after the switch survived a restart would
 * be exactly the "settings pane disagrees with the runtime" failure S12 exists
 * to remove.
 *
 * Runs with `npm run test:e2e:electron`. Not part of `verify:full` (E2E is the
 * outer gate, TESTING.md §9).
 */
import { expect, test } from '@playwright/test';
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
const SCREENSHOT_DIR = path.join(REPO_ROOT, 'test-results', 'browser-config-batch4');

function screenshotPath(name: string): string {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  return path.join(SCREENSHOT_DIR, `${name}.png`);
}

const WELCOME = /交给阿布就行啦|Leave it to Abu/;
const CHAT_PLACEHOLDER = /^(想让阿布帮你做点什么？|What can Abu help you with\?)$/;
const QUICK_START = /^(快速入门|Quick Start)$/;
const ACCOUNT = /^(我|Me)$/;
const SETTINGS = /^(设置|Settings)$/;
const CAPABILITIES = /^(能力|Capabilities)$/;
const BUILTIN_BROWSER = /^(阿布内置浏览器|Abu built-in browser)$/;
const MASTER_SWITCH = /(允许定时任务|Let scheduled tasks)/;
const PREVIEW_LABEL = /^(预览：某个网站上阿布能做什么|Preview: what Abu can do on a site)$/;
const SAVED = /^(已保存|Saved)$/;
const VIEW_PAGES = /^(只看页面|View pages)$/;
const AUTOMATIC_COLUMN = /^(自动任务|Automatic tasks)$/;
const REFUSED = /^(拒绝|Refused)$/;
const ALLOWED = /^(允许|Allowed)$/;

const PREVIEW_SITE = 'https://reports.example.com';

async function waitForWelcomeScreen(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await expect(
    page.getByText(WELCOME).or(page.getByPlaceholder(CHAT_PLACEHOLDER)).first(),
  ).toBeVisible({ timeout: READY_TIMEOUT });

  const quickStart = page.getByText(QUICK_START, { exact: true });
  await quickStart.waitFor({ state: 'visible', timeout: 1_500 }).catch(() => {});
  if (await quickStart.isVisible()) {
    await page.keyboard.press('Escape');
    await expect(quickStart).toBeHidden();
  }
}

/** Settings → Capabilities → the built-in browser's detail page. */
async function openBuiltinBrowserDetail(page: Page): Promise<void> {
  await page.getByRole('button', { name: ACCOUNT }).click();
  await page.getByRole('menuitem', { name: SETTINGS }).click();
  await page.getByRole('button', { name: CAPABILITIES }).click();
  await page
    .getByRole('button', { name: new RegExp(BUILTIN_BROWSER.source.replace(/\$$/, '')) })
    .click();
  await expect(page.getByText(MASTER_SWITCH)).toBeVisible({ timeout: READY_TIMEOUT });
}

/**
 * The preview's verdict for one operation class in the automatic-task column.
 *
 * Read off the rendered table rather than from any store, because the whole
 * point is what a user can see. Only the FIRST line: the cell carries the
 * verdict and, under it, the one-line reason, and this is asserting the
 * verdict.
 */
async function automaticVerdictFor(page: Page, rowLabel: RegExp): Promise<string> {
  const header = page.getByRole('columnheader', { name: AUTOMATIC_COLUMN });
  await expect(header).toBeVisible();
  const columnIndex = await header.evaluate(
    (el) => Array.from(el.parentElement?.children ?? []).indexOf(el),
  );
  const row = page.getByRole('rowheader', { name: rowLabel }).locator('xpath=..');
  const cell = await row.locator('td').nth(columnIndex - 1).innerText();
  return (cell.split('\n')[0] ?? '').trim();
}

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;

test.describe.serial('browser permission config survives a restart', () => {
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

  test('the master switch is saved, read back after a relaunch, and moves the preview', async () => {
    dataRoot = createElectronDataRoot();

    // ── First launch: the shipped default, and a preview that says so ──────
    const first = await launchAbuElectron(dataRoot);
    app = first.app;
    let page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForWelcomeScreen(page);
    await openBuiltinBrowserDetail(page);

    const preview = page.getByLabel(PREVIEW_LABEL);
    await expect(preview).toBeVisible();
    await preview.fill(PREVIEW_SITE);

    // The master switch ships off, so nothing an automatic task asks for is
    // allowed — including a plain read.
    expect(await automaticVerdictFor(page, VIEW_PAGES)).toMatch(REFUSED);
    await page.screenshot({ path: screenshotPath('01-preview-master-switch-off') });

    // ── Turn it on, and watch the save be CONFIRMED, not merely rendered ───
    const masterSwitchRow = page.getByText(MASTER_SWITCH).locator('xpath=../..');
    await masterSwitchRow.getByRole('switch').click();
    await expect(page.getByText(SAVED)).toBeVisible({ timeout: 5_000 });

    // Same input, same site: the preview follows the setting it reports on.
    expect(await automaticVerdictFor(page, VIEW_PAGES)).toMatch(ALLOWED);
    await page.screenshot({ path: screenshotPath('02-preview-master-switch-on') });

    // ── Restart the SAME profile ──────────────────────────────────────────
    await closeAbuElectron(app);
    const second = await launchAbuElectron(dataRoot);
    app = second.app;
    page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForWelcomeScreen(page);
    await openBuiltinBrowserDetail(page);

    // The switch really persisted — this is the assertion a React-only test
    // cannot make.
    const reloadedSwitch = page.getByText(MASTER_SWITCH).locator('xpath=../..').getByRole('switch');
    await expect(reloadedSwitch).toHaveAttribute('aria-checked', 'true');

    // And the preview, rebuilt from the rehydrated store, still agrees.
    const reloadedPreview = page.getByLabel(PREVIEW_LABEL);
    await reloadedPreview.fill(PREVIEW_SITE);
    expect(await automaticVerdictFor(page, VIEW_PAGES)).toMatch(ALLOWED);
    await page.screenshot({ path: screenshotPath('03-after-restart') });
  });
});
