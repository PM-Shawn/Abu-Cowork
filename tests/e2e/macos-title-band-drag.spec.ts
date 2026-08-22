/**
 * Real-Electron guard for the macOS title band: "the middle of the top bar
 * cannot drag the window".
 *
 * macOS has no chrome row of its own. `titleBarStyle: 'hidden'` leaves the
 * content card starting 8px below the window top, so the band beside the
 * traffic lights *is* the card — and the card is `data-electron-no-drag`, whose
 * `!important` descendant rule made it impossible for anything inside to become
 * a drag region. Measured before the fix: only y 0-8 was draggable; every point
 * from y 10 to 48 resolved to no-drag.
 *
 * The fix marks each view's own header row with `data-electron-drag`, an escape
 * valve that outranks the card's blanket no-drag while leaving the row's
 * children (titles, buttons) no-drag automatically.
 *
 * 🔴 SCOPE — what this test can and cannot prove.
 * Draggable regions are consumed by the OS *before* the renderer sees a mouse
 * event. Playwright dispatches input through CDP, which is below that layer, so
 * a synthetic drag "succeeds" whether or not the fix is present. This test
 * therefore asserts the *region map Chromium hands the OS* — the input to the
 * real behavior — and nothing more. "The window actually follows the mouse"
 * must be confirmed by hand on a real Mac. Do not let this green test stand in
 * for that.
 */
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import {
  appRegionAt,
  closeAbuElectron,
  createElectronDataRoot,
  launchAbuElectron,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;
const CHAT_PLACEHOLDER = '想让阿布帮你做点什么？';
/** Mid-height of the 44px band that sits beside the traffic lights. */
const BAND_Y = 25;

async function waitForApp(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
}

async function dismissFirstRunOverlays(page: Page): Promise<void> {
  await page.evaluate(() => {
    const raw = window.localStorage.getItem('abu-settings');
    if (!raw) throw new Error('abu-settings was not initialized before E2E configuration');
    const persisted = JSON.parse(raw) as { state: Record<string, unknown>; version: number };
    Object.assign(persisted.state, {
      guideShown: true,
      guideOpen: false,
      hasAcknowledgedDisclaimer: true,
      hasRunSensitiveAudit_v015: true,
    });
    window.localStorage.setItem('abu-settings', JSON.stringify(persisted));
  });
  await page.reload();
  await waitForApp(page);
}

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;

test.describe.serial('Electron macOS title band', () => {
  test.afterEach(async () => {
    if (app) {
      await closeAbuElectron(app);
      app = undefined;
    }
    if (dataRoot) {
      removeElectronDataRoot(dataRoot);
      dataRoot = undefined;
    }
  });

  test('the band is draggable across views while its controls stay clickable', async () => {
    test.skip(process.platform !== 'darwin', 'the band only exists on macOS chrome');

    dataRoot = createElectronDataRoot();
    const launched = await launchAbuElectron(dataRoot);
    app = launched.app;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    await dismissFirstRunOverlays(page);

    const width = await page.evaluate(() => window.innerWidth);
    // Sample the card's share of the band, well clear of the sidebar column.
    const cardXs = [Math.round(width * 0.4), Math.round(width * 0.6), Math.round(width * 0.8)];

    // The welcome screen — the view a user meets first, and the one that had no
    // header row at all until this fix gave it a spacer.
    for (const x of cardXs) {
      expect(await appRegionAt(page, x, BAND_Y), `welcome view at x=${x}`).toBe('drag');
    }
    // The 8px strip that was previously the ONLY draggable pixel row still is.
    expect(await appRegionAt(page, cardXs[1], 4)).toBe('drag');

    // The floating window controls overlay the band and paint after the card.
    // They must still win, or the fix would trade a drag bug for a click bug —
    // exactly the failure this whole change set exists to prevent.
    const controls = page.locator('[data-window-control]');
    const controlCount = await controls.count();
    expect(controlCount).toBeGreaterThan(0);
    for (let index = 0; index < controlCount; index += 1) {
      const box = await controls.nth(index).boundingBox();
      if (!box) throw new Error(`window control ${index} has no box`);
      const region = await appRegionAt(page, box.x + box.width / 2, box.y + box.height / 2);
      expect(region, `window control ${index} must stay clickable`).toBe('no-drag');
    }

    // A second view, reached through its own layout path (TopTabNav), so the
    // fix is not silently welcome-screen-only.
    await page.getByRole('button', { name: /^(工具箱|Toolbox)$/ }).click();
    await expect(page.getByRole('button', { name: /^(工具箱|Toolbox)$/ })).toBeVisible();
    for (const x of cardXs) {
      expect(await appRegionAt(page, x, BAND_Y), `toolbox view at x=${x}`).toBe('drag');
    }
  });
});
