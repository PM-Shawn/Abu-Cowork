import { defineConfig } from '@playwright/test';

/**
 * Playwright config for the REAL-Electron-app E2E smoke suite
 * (`tests/e2e/smoke.spec.ts`), kept separate from:
 *   - `playwright.config.ts` (testDir `./e2e`) — drives the Vite dev server
 *     over `page.goto()`, not a real Electron launch.
 *   - `vitest.config.ts` — unit/integration tests.
 *
 * No `webServer`/`baseURL` here: each test launches its own Electron process
 * directly via `_electron.launch()` (see tests/e2e/electronHelpers.ts).
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  timeout: 90_000,
  globalSetup: './tests/e2e/global-setup.ts',
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
  },
});
