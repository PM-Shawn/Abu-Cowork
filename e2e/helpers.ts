import type { Page } from '@playwright/test';

/**
 * Pre-populate localStorage with the minimal abu-settings needed for E2E:
 *   - One Anthropic provider with a fake API key (bypasses "no provider" guard)
 *   - language: 'zh-CN' so Chinese UI text assertions work in CI
 *   - guideShown / hasAcknowledgedDisclaimer / hasRunSensitiveAudit_v015 so
 *     one-time modals don't block the tests
 *
 * All other settings use store defaults (theme, sidebarCollapsed, etc.).
 * The version must match the current minVersion so no migration runs.
 */
async function injectSettings(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const settings = {
      state: {
        providers: [
          {
            id: 'anthropic',
            source: 'builtin',
            name: 'Anthropic',
            enabled: true,
            apiFormat: 'anthropic',
            baseUrl: 'https://api.anthropic.com',
            apiKey: 'sk-ant-e2e-fake-key-for-testing',
            models: [{ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', capabilities: {} }],
            capabilities: {},
            status: 'unchecked',
            sortOrder: 0,
          },
        ],
        activeModel: { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' },
        language: 'zh-CN',
        guideShown: true,
        hasAcknowledgedDisclaimer: true,
        hasRunSensitiveAudit_v015: true,
      },
      version: 33,
    };
    localStorage.setItem('abu-settings', JSON.stringify(settings));
  });
}

/**
 * Set up E2E prerequisites: seed localStorage so the app starts in a
 * usable state (provider configured, one-time modals dismissed, zh-CN UI).
 * Call before page.goto() so the script runs before React hydrates.
 */
export async function setupAbuSettings(page: Page): Promise<void> {
  await injectSettings(page);
}

/**
 * Wait for the React root to be mounted.
 */
export async function waitForAppReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (window as unknown as Record<string, unknown>).__abuRootMounted === true,
    { timeout: 30_000 },
  );
}
