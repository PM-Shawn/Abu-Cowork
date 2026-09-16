/**
 * The 「关于作者」 page, walked through the real Electron shell:
 * feedback page → its pointer to the author page → the author page itself →
 * a QR code enlarged and dismissed → the slimmed-down 「版本」 page.
 */
import { expect, test } from '@playwright/test';
import path from 'node:path';
import type { ElectronApplication, Page } from 'playwright';
import {
  closeAbuElectron,
  createElectronDataRoot,
  dismissFirstRunOverlays,
  launchAbuElectron,
  removeElectronDataRoot,
  REPO_ROOT,
  type ElectronDataRoot,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;
const CHAT_PLACEHOLDER = '想让阿布帮你做点什么？';
const SHOT = (name: string) => path.join(REPO_ROOT, 'test-results', `e2e-author-${name}.png`);

const ACCOUNT = /^(我|Me)$/;
const SETTINGS = /^(设置|Settings)$/;
const FEEDBACK_TAB = /^(反馈|Feedback)$/;
const VERSION_TAB = /^(版本|Version)$/;
const AUTHOR_TAB = /^(关于作者|About the author)$/;
const GO_TO_AUTHOR = /去「关于作者」页|Go to "About the author"/;
const SPONSOR_TILE = /^(请作者喝杯咖啡|Buy me a coffee)/;
const WECHAT_TILE = /^(关注公众号|Official account)/;

async function waitForApp(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
}

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;

test.describe.serial('Electron author page', () => {
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

  test('feedback points to the author page; QR codes enlarge; version page is just the version', async () => {
    dataRoot = createElectronDataRoot();
    const launched = await launchAbuElectron(dataRoot);
    app = launched.app;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    await dismissFirstRunOverlays(page);

    await page.getByRole('button', { name: ACCOUNT }).first().click();
    await page.getByRole('menuitem', { name: SETTINGS }).click();

    // Feedback no longer hosts the contact QR; it hands off to the author page.
    await page.getByRole('button', { name: FEEDBACK_TAB }).click();
    await expect(page.getByText(/想直接找作者|reach the author directly/)).toBeVisible();
    await expect(page.getByText(/^(联系开发者|Contact Developer)$/)).toHaveCount(0);
    await page.screenshot({ path: SHOT('feedback') });
    await page.getByRole('button', { name: GO_TO_AUTHOR }).click();

    // The author page.
    await expect(page.getByRole('heading', { name: AUTHOR_TAB })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Shawn' })).toBeVisible();
    await expect(page.getByText(/月消耗 Token 300 亿|30B tokens a month/)).toBeVisible();
    await expect(page.getByRole('img', { name: WECHAT_TILE })).toBeVisible();
    await expect(page.getByRole('img', { name: SPONSOR_TILE })).toBeVisible();
    await expect(page.getByRole('button', { name: /小红书|Xiaohongshu/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^X$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /GitHub/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /myabu\.cn/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^(免责声明|Disclaimer)$/ })).toBeVisible();
    await page.screenshot({ path: SHOT('page') });

    // A QR code enlarges on click and closes on Escape.
    await page.getByRole('button', { name: SPONSOR_TILE }).click();
    const zoom = page.getByRole('dialog', { name: SPONSOR_TILE });
    await expect(zoom).toBeVisible();
    // The enlarged code must actually be painted, not just present — a blank
    // 260px box would be exactly the failure a person scanning it would hit.
    const zoomImg = zoom.getByRole('img', { name: SPONSOR_TILE });
    await expect.poll(() => zoomImg.evaluate((el) => {
      const img = el as HTMLImageElement;
      return img.complete && img.naturalWidth > 0;
    })).toBe(true);
    await page.screenshot({ path: SHOT('qr-zoom') });
    await page.keyboard.press('Escape');
    await expect(zoom).toHaveCount(0);

    // The version page kept only what is about the version.
    await page.getByRole('button', { name: VERSION_TAB }).click();
    await expect(page.getByRole('heading', { name: VERSION_TAB })).toBeVisible();
    await expect(page.getByText(/^(当前版本|Current version)$/)).toBeVisible();
    await expect(page.getByRole('button', { name: /^(免责声明|Disclaimer)$/ })).toHaveCount(0);
    await expect(page.getByText(/Made with/)).toHaveCount(0);
    await page.screenshot({ path: SHOT('version') });

    // And the author tab is reachable from the nav on its own.
    await page.getByRole('button', { name: AUTHOR_TAB }).click();
    await expect(page.getByRole('heading', { name: 'Shawn' })).toBeVisible();
  });
});
