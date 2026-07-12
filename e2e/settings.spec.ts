import { test, expect } from '@playwright/test';
import { setupAbuSettings, waitForAppReady } from './helpers';

test.describe('Settings', () => {
  test.beforeEach(async ({ page }) => {
    await setupAbuSettings(page);
    await page.goto('/');
    await waitForAppReady(page);
  });

  test('pre-configured provider settings are rehydrated into the app', async ({ page }) => {
    // The injected settings include an Anthropic provider with an apiKey.
    // If the app successfully reads those settings, it renders the chat UI
    // without the "no provider configured" banner (needsSetup=false).
    // If the settings were ignored or wiped, the banner would appear.
    await expect(page.getByText('还差一步就好啦～')).not.toBeVisible({ timeout: 5000 });

    // The provider record also survives the app's localStorage lifecycle:
    // bootstrapSecrets() in web mode can't reach the Tauri secure store, so
    // the apiKey stays in plaintext in abu-settings as a fallback.
    const settings = await page.evaluate(() => {
      const raw = localStorage.getItem('abu-settings');
      if (!raw) return null;
      return JSON.parse(raw) as {
        state: { providers: Array<{ id: string; enabled: boolean; name: string }> };
      };
    });

    expect(settings).not.toBeNull();
    const anthropic = settings?.state?.providers?.find((p) => p.id === 'anthropic');
    expect(anthropic).toBeTruthy();
    expect(anthropic?.enabled).toBe(true);
  });

  test('settings panel opens via gear button into the settings view', async ({ page }) => {
    // The gear button now has aria-label="系统设置" (added in Sidebar.tsx).
    // We click it by accessible name rather than a brittle positional selector.
    const gearBtn = page.getByRole('button', { name: '系统设置' }).first();
    await expect(gearBtn).toBeVisible();
    await gearBtn.click();

    // Assert on an element UNIQUE to the settings view, not the same-named
    // gear/back button (which would stay visible even if navigation no-oped —
    // a false green). SystemSettingsModal renders a left-nav whose '偏好'
    // (t.settings.general) item exists ONLY inside the settings view, so its
    // visibility proves we actually transitioned into viewMode='settings'.
    await expect(
      page.getByRole('button', { name: '偏好' }).first(),
    ).toBeVisible({ timeout: 5000 });
  });
});
