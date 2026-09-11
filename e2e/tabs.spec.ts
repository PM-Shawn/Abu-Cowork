import { test, expect } from '@playwright/test';
import { setupAbuSettings, waitForAppReady } from './helpers';

test.describe('Tab Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await setupAbuSettings(page);
    await page.goto('/');
    await waitForAppReady(page);
  });

  test('extensions button shows extensions view', async ({ page }) => {
    // Extensions button in sidebar nav (t.sidebar.extensions = '扩展'). Scope it
    // to the navigation region so it cannot match anything the panel renders.
    const extensionsBtn = page
      .getByLabel('Main navigation')
      .getByRole('button', { name: '扩展' });
    await expect(extensionsBtn).toBeVisible();
    await extensionsBtn.click();

    // The Extensions view (ExtensionsView, formerly the toolbox) carries no page
    // title — its top tabs (插件 / 技能 / 连接器) are the header. Those tab
    // buttons live in the panel, not the sidebar, so their visibility confirms
    // we actually transitioned into the view.
    const panel = page.getByRole('main');
    await expect(panel.getByRole('button', { name: '插件' })).toBeVisible({ timeout: 5000 });
    await expect(panel.getByRole('button', { name: '技能' })).toBeVisible();
    await expect(panel.getByRole('button', { name: '连接器' })).toBeVisible();
    // Sources are stacked within each panel, not another navigation row.
    // Native plugin data is covered by the real-Electron suite.
    await expect(page.getByTestId('extensions-source-market')).toHaveCount(0);
    await expect(page.getByTestId('extensions-source-mine')).toHaveCount(0);
    await panel.getByRole('button', { name: '技能', exact: true }).click();
    await expect(page.getByTestId('skill-create-trigger')).toBeVisible();
  });

  test('automation button shows automation view', async ({ page }) => {
    // Automation button in sidebar nav (t.sidebar.automation = '自动化')
    const automationBtn = page.getByRole('button', { name: '自动化' });
    await expect(automationBtn).toBeVisible();
    await automationBtn.click();

    // After entering automation view, AutomationView renders a left-nav with
    // sub-tabs (定时任务 / 监听事件). These are unique to AutomationView.
    await expect(
      page.getByRole('button', { name: '定时任务' }).first(),
    ).toBeVisible({ timeout: 5000 });
  });
});
