import { test, expect } from '@playwright/test';
import { setupAbuSettings, waitForAppReady } from './helpers';

test.describe('Smoke', () => {
  test.beforeEach(async ({ page }) => {
    await setupAbuSettings(page);
    await page.goto('/');
    await waitForAppReady(page);
  });

  test('main interface renders with sidebar and chat input', async ({ page }) => {
    // Sidebar navigation is present (aria-label from Sidebar.tsx)
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();

    // "新建任务" button in sidebar
    await expect(page.getByRole('button', { name: '新建任务' }).first()).toBeVisible();

    // Chat textarea is present (welcome screen always shows input)
    const chatInput = page.locator('textarea').first();
    await expect(chatInput).toBeVisible();
  });
});
