import { test, expect } from '@playwright/test';
import { setupAbuSettings, waitForAppReady } from './helpers';

test.describe('Preview and workspace journey', () => {
  test.beforeEach(async ({ page }) => {
    await setupAbuSettings(page);
    await page.goto('/');
    await waitForAppReady(page);
  });

  test('keeps the workspace choice visible for a new unbound task', async ({ page }) => {
    const workspaceContext = page.locator('[data-abu-workspace-context]');

    await expect(workspaceContext).toBeVisible();
    await expect(workspaceContext.getByRole('button', { name: '选择工作区' })).toBeVisible();
  });

  test('opens an image preview, uses reading controls, and switches workspace tabs', async ({ page }) => {
    await page.evaluate(async () => {
      const previewModulePath = '/src/stores/previewStore.ts';
      const settingsModulePath = '/src/stores/settingsStore.ts';
      const [{ usePreviewStore }, { useSettingsStore }] = await Promise.all([
        import(previewModulePath),
        import(settingsModulePath),
      ]);
      useSettingsStore.getState().setRightPanelCollapsed(false);
      usePreviewStore.getState().openPreview(
        'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="64" height="64"%3E%3Crect width="64" height="64" fill="%23c76f4b"/%3E%3C/svg%3E',
      );
    });

    const panel = page.locator('[data-abu-right-panel]');
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('img', { name: '图片预览' })).toBeVisible();

    await panel.getByTitle('放大图片').click();
    await expect(panel.getByText('125%')).toBeVisible();

    await panel.getByTitle('向右旋转').click();
    await expect(panel.getByRole('img', { name: '图片预览' })).toHaveCSS(
      'transform',
      /matrix\(0, 1\.25, -1\.25, 0,/,
    );

    await panel.getByRole('button', { name: '新建标签页' }).click();
    await page.getByRole('button', { name: '新建浏览器' }).click();
    await expect(panel.locator('[role="tab"]').filter({ hasText: '新标签页' })).toBeVisible();

    await panel.locator('[role="tab"]').filter({ hasText: '图片预览' }).click();
    await expect(panel.getByText('125%')).toBeVisible();
  });
});
