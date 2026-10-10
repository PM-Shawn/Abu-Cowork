import { expect, test, type Page } from '@playwright/test';
import { PREVIEW_SECTIONS } from '../../src/components/design-preview/sections/sectionIds';
import { closeAbuElectron, dismissFirstRunOverlays, launchAbuElectron, removeElectronDataRoot } from './electronHelpers';

const READY_TIMEOUT = 60_000;
const CHAT_PLACEHOLDER = /^(想让阿布帮你做点什么？|What can Abu help you with\?)$/;

const APPEARANCES = [
  { name: 'light', dark: false, contrast: false },
  { name: 'dark', dark: true, contrast: false },
  { name: 'light-contrast', dark: false, contrast: true },
  { name: 'dark-contrast', dark: true, contrast: true },
] as const;

// The preview is a window-high scroll container, which cuts off any section taller than the
// window. For capture, let it flow at full height so each section screenshot holds all of it.
async function unrollPreview(page: Page): Promise<void> {
  await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-design-preview-host]');
    const root = document.querySelector<HTMLElement>('[data-design-preview-root]');
    if (!host || !root) throw new Error('design preview is not open');
    host.style.setProperty('position', 'absolute', 'important');
    host.style.setProperty('bottom', 'auto', 'important');
    root.style.setProperty('height', 'auto', 'important');
    root.style.setProperty('overflow', 'visible', 'important');
  });
}

async function setSwitch(page: Page, name: string, on: boolean): Promise<void> {
  const control = page.getByRole('switch', { name, exact: true });
  if ((await control.getAttribute('aria-checked')) !== String(on)) await control.click();
  await expect(control).toHaveAttribute('aria-checked', String(on));
}

test.describe('design preview — visual regression', () => {
  test.skip(!process.env.CI, 'Baselines come from the CI macOS runner; local font rendering differs.');

  test('every section matches its baseline in four appearances', async () => {
    // One launch plus 28 captures does not fit in the 90 s default.
    test.setTimeout(240_000);
    const launched = await launchAbuElectron();
    try {
      const page = await launched.app.firstWindow({ timeout: READY_TIMEOUT });
      // The settings store must exist before the first-run acknowledgements are seeded.
      await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
      await dismissFirstRunOverlays(page);
      // The shortcut listener arrives in a lazily loaded chunk, which can land after the
      // composer is ready. The host element is attached in the keydown handler itself, so a
      // press that found no listener leaves no host and is safe to repeat.
      const host = page.locator('[data-design-preview-host]');
      await expect(async () => {
        if ((await host.count()) === 0) await page.keyboard.press('Meta+Alt+Shift+KeyD');
        await expect(host).toHaveCount(1, { timeout: 500 });
      }).toPass({ timeout: 30_000 });
      await expect(page.locator('[data-design-preview-root]')).toBeVisible();
      await unrollPreview(page);
      await setSwitch(page, 'Reduce motion', true);
      // The runner's own OS setting must not leak into the baselines.
      await setSwitch(page, 'Reduce transparency', false);
      for (const appearance of APPEARANCES) {
        await page.getByRole('group', { name: 'Appearance' }).getByRole('radio', { name: appearance.dark ? 'Dark' : 'Light', exact: true }).click();
        await setSwitch(page, 'Increase contrast', appearance.contrast);
        for (const section of PREVIEW_SECTIONS) {
          // Soft: one run records every missing or changed screenshot, not just the first.
          await expect.soft(page.locator(`[data-preview-section="${section}"]`)).toHaveScreenshot(`${section}-${appearance.name}.png`);
        }
      }
    } finally {
      await closeAbuElectron(launched.app);
      removeElectronDataRoot(launched);
    }
  });
});
