import { test, expect } from '@playwright/test';
import { setupAbuSettings, waitForAppReady } from './helpers';

/**
 * E2E for the simplified skill create menu + merged upload modal.
 *
 * Verifies the Phase-E refactor at the UI layer (the Tauri-native install
 * itself — folder picker / drag-drop / real fs scope — can't be driven
 * headlessly on macOS, so that stays a manual desktop smoke step):
 *   - the "+" menu shows exactly 3 entries (AI / manual / import)
 *   - the two removed network-install entries are gone
 *   - the merged "导入技能" entry opens a modal with a drop zone + two pickers
 */
test.describe('Skill upload menu (Phase E)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAbuSettings(page);
    await page.goto('/');
    await waitForAppReady(page);
    // Enter toolbox → 技能 tab (mirrors tabs.spec.ts).
    await page.getByRole('button', { name: '工具箱' }).click();
    await expect(page.getByRole('button', { name: '技能' }).first()).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: '技能' }).first().click();
    await page.getByTestId('skill-create-trigger').click();
    await expect(page.getByTestId('skill-create-menu')).toBeVisible();
  });

  test('the "+" create menu has exactly 3 entries and drops the two network installers', async ({ page }) => {
    const menu = page.getByTestId('skill-create-menu');

    // Exactly 3 entries, in order.
    await expect(menu.locator('button')).toHaveCount(3);
    await expect(menu.getByText('使用阿布创建', { exact: true })).toBeVisible();
    await expect(menu.getByText('手动创建', { exact: true })).toBeVisible();
    await expect(menu.getByText('导入技能', { exact: true })).toBeVisible();

    // The two removed entries must NOT exist anywhere on the page.
    await expect(page.getByText('从注册表安装', { exact: true })).toHaveCount(0);
    await expect(page.getByText('安装 Agent Skills', { exact: true })).toHaveCount(0);
  });

  test('"导入技能" opens the unified upload modal: clickable drop zone + archive link', async ({ page }) => {
    await page.getByTestId('skill-create-menu').getByText('导入技能', { exact: true }).click();

    // The drop zone is itself a clickable button (drag OR click), not just a target.
    await expect(page.getByRole('button', { name: /拖放文件夹到这里/ })).toBeVisible();
    // Archives are a secondary link (Tauri can't pick folder+file in one dialog).
    await expect(page.getByRole('button', { name: /\.askill/ })).toBeVisible();
  });
});
