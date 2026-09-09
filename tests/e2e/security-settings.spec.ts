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

async function openSecurity(page: Page) {
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
  await page.getByRole('button', { name: /^(我|Me)$/ }).first().click();
  await page.getByRole('menuitem', { name: /^(设置|Settings)$/ }).click();
  await page.getByRole('button', { name: '安全', exact: true }).click();
  await expect(page.getByText('默认权限模式', { exact: true })).toBeVisible();
}

async function savedMode(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('abu-settings')!).state.permissionMode as string);
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

test('security settings dropdown saves modes and keeps protection confirmations', async () => {
  const testInfo = test.info();
  const launched = await launchAbuElectron();
  app = launched.app;
  dataRoot = launched;
  let page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
  await dismissFirstRunOverlays(page);
  // Set only this disposable profile's baseline; changes under test use the UI.
  await page.evaluate(() => {
    const persisted = JSON.parse(localStorage.getItem('abu-settings')!);
    Object.assign(persisted.state, {
      theme: 'light', permissionMode: 'standard', sandboxEnabled: true,
      networkIsolationEnabled: false,
      safety: { ...persisted.state.safety, enableContentGuard: true },
    });
    localStorage.setItem('abu-settings', JSON.stringify(persisted));
  });
  await page.reload();
  const initialWindow = await app.browserWindow(page);
  await initialWindow.evaluate(win => win.setContentSize(1198, 796));
  await openSecurity(page);
  await page.locator('[data-abu-settings-dialog] > div').screenshot({ path: testInfo.outputPath('security-light.png') });

  const selector = page.getByRole('button', { name: /^默认权限模式:/ });
  await selector.click();
  await expect(page.getByText(/越界操作交 AI 审核/)).toBeVisible();
  await page.locator('[data-abu-settings-dialog] > div').screenshot({ path: testInfo.outputPath('security-menu.png') });
  await page.getByRole('button', { name: /^替我审批 越界操作/ }).click();
  await expect.poll(() => savedMode(page)).toBe('smart');
  await expect(selector).toHaveAttribute('aria-expanded', 'false');

  await selector.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: /^替我审批 越界操作/ })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect.poll(() => savedMode(page)).toBe('autonomous');
  await selector.click();
  await page.getByRole('button', { name: /^请求批准 工作区/ }).click();
  await expect.poll(() => savedMode(page)).toBe('standard');

  await page.getByText('沙箱保护', { exact: true }).click();
  await expect(page.getByText(/关闭沙箱后，AI 执行的/)).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByText('内容安全扫描', { exact: true }).click();
  await expect(page.getByText('关闭内容安全扫描？', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  const protection = await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('abu-settings')!).state;
    return [state.sandboxEnabled, state.networkIsolationEnabled, state.safety.enableContentGuard];
  });
  expect(protection).toEqual([true, false, true]);

  await selector.click();
  await page.getByRole('button', { name: /^替我审批 越界操作/ }).click();
  await expect.poll(() => savedMode(page)).toBe('smart');
  await closeAbuElectron(app);
  app = undefined;
  app = (await launchAbuElectron(dataRoot)).app;
  page = await app.firstWindow({ timeout: READY_TIMEOUT });
  const window = await app.browserWindow(page);
  await window.evaluate(win => win.setContentSize(1198, 796));
  await openSecurity(page);
  await expect(page.getByRole('button', { name: '默认权限模式: 替我审批', exact: true })).toBeVisible();

  await page.getByRole('button', { name: '偏好', exact: true }).click();
  await page.getByRole('button', { name: '暗色', exact: true }).click();
  await page.getByRole('button', { name: '安全', exact: true }).click();
  await page.locator('[data-abu-settings-dialog] > div').screenshot({ path: testInfo.outputPath('security-dark.png') });

  await window.evaluate(win => win.setSize(900, 720));
  const narrowSelector = page.getByRole('button', { name: /^默认权限模式:/ });
  await narrowSelector.click();
  await page.getByRole('button', { name: /^完全自主 电脑操控/ }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: /^完全自主 电脑操控/ })).toBeVisible();
  await page.locator('[data-abu-settings-dialog] > div').screenshot({ path: testInfo.outputPath('security-narrow-menu.png') });
  await page.keyboard.press('Escape');
  // The existing settings dialog also closes on Escape; neither exit selects a mode.
  await expect(page.getByRole('button', { name: /^完全自主 电脑操控/ })).toBeHidden();
  await expect.poll(() => savedMode(page)).toBe('smart');
});
