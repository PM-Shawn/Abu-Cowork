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

  test('settings panel opens from the account menu into the settings view', async ({ page }) => {
    // The settings entry moved out of a standalone gear button and into the
    // account popover (AccountMenu): the sidebar-bottom avatar trigger opens a
    // menu, and a "设置" (t.settings.title) menuitem opens settings — which now
    // renders as an overlay dialog (SystemSettingsDialog), not a view swap.
    // In E2E, setupAbuSettings sets no nickname, so the trigger's accessible
    // name is the default nickname "我" (t.sidebar.defaultNickname).
    const accountTrigger = page.getByRole('button', { name: '我', exact: true });
    await expect(accountTrigger).toBeVisible();
    await accountTrigger.click();

    const settingsItem = page.getByRole('menuitem', { name: '设置' });
    await expect(settingsItem).toBeVisible();
    await settingsItem.click();

    // Assert on an element UNIQUE to the settings view. SystemSettingsModal
    // renders a left-nav whose '偏好' (t.settings.general) item exists ONLY
    // inside settings, so its visibility proves we actually opened it.
    await expect(
      page.getByRole('button', { name: '偏好' }).first(),
    ).toBeVisible({ timeout: 5000 });
  });
});
