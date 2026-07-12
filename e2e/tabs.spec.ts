import { test, expect } from '@playwright/test';
import { setupAbuSettings, waitForAppReady } from './helpers';

test.describe('Tab Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await setupAbuSettings(page);
    await page.goto('/');
    await waitForAppReady(page);
  });

  test('toolbox button shows toolbox view', async ({ page }) => {
    // Toolbox button in sidebar nav (t.sidebar.toolbox = '工具箱')
    const toolboxBtn = page.getByRole('button', { name: '工具箱' });
    await expect(toolboxBtn).toBeVisible();
    await toolboxBtn.click();

    // After entering toolbox view, the ToolboxModal renders a left-nav with
    // sub-tabs (技能 / 代理 / MCP). These buttons are unique to ToolboxView —
    // they do NOT exist in the sidebar — so their visibility confirms we
    // actually transitioned into the toolbox view.
    await expect(
      page.getByRole('button', { name: '技能' }).first(),
    ).toBeVisible({ timeout: 5000 });
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
