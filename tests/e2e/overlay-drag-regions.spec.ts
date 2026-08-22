/**
 * Real-Electron journey for the Windows dead-click reports: on a laptop at
 * 125%/150% display scaling the system-settings dialog's close button stopped
 * responding, and the same was true for anything else that landed in the top
 * chrome band.
 *
 * Mechanism: the Windows chrome paints two 36px rows whose empty space is a
 * `-webkit-app-region: drag` lane, so the top 72px of the window moves the
 * window. That region is resolved by the OS as a *geometry union* and ignores
 * z-index — an overlay painted above a lane does not take its place. Windows
 * keeps hit-testing the rectangle as HTCAPTION, turns the press into a window
 * move, and the click never reaches the renderer. The shorter the viewport, the
 * higher the centred dialog sits, and below ~960 CSS px its close button is
 * fully inside the band.
 *
 * The fix: every layer painted above the chrome declares `data-electron-no-drag`
 * on its root, which the stylesheet turns into `-webkit-app-region: no-drag`
 * for the root and every descendant, subtracting the overlay from the lane.
 *
 * This test reproduces the reported viewport (1200x745 — 1080p at 150%) in an
 * isolated Electron instance, then asserts the close button is genuinely
 * hit-testable: it resolves to `no-drag`, no drag layer is painted above it,
 * and `elementFromPoint` returns the button itself. `src/__tests__/
 * overlayDragRegions.test.ts` guards the same invariant statically for every
 * other overlay in the tree.
 */
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import {
  closeAbuElectron,
  createElectronDataRoot,
  launchAbuElectron,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;
const CHAT_PLACEHOLDER = '想让阿布帮你做点什么？';
/** 1080p at 150% scaling: the geometry the dead-click reports came from. */
const REPORTED_VIEWPORT = { width: 1200, height: 745 };

async function waitForApp(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
}

/** A fresh data root shows the first-run guide, which covers the whole window. */
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

test.describe.serial('Electron overlay hit testing — window drag lanes', () => {
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

  test('the settings dialog close button stays clickable inside the chrome band', async () => {
    dataRoot = createElectronDataRoot();
    const launched = await launchAbuElectron(dataRoot);
    app = launched.app;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    await dismissFirstRunOverlays(page);

    // Shrink to the reported viewport so the centred dialog rides up into the
    // chrome band. A maximized window cannot be resized, hence the unmaximize.
    await app.evaluate(({ BrowserWindow }, viewport) => {
      const [mainWindow] = BrowserWindow.getAllWindows();
      if (!mainWindow) throw new Error('main window missing');
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      mainWindow.setContentSize(viewport.width, viewport.height);
    }, REPORTED_VIEWPORT);

    await page.getByRole('button', { name: /^(我|Me)$/ }).first().click();
    await page.getByRole('menuitem', { name: /^(设置|Settings)$/ }).click();

    const dialog = page.locator('[data-abu-settings-dialog]');
    await expect(dialog).toBeVisible({ timeout: READY_TIMEOUT });
    const closeButton = page.locator('[data-abu-settings-close]');
    await expect(closeButton).toBeVisible();

    const hitTest = await page.evaluate(() => {
      const close = document.querySelector('[data-abu-settings-close]');
      const scrim = document.querySelector('[data-abu-settings-dialog]');
      if (!close || !scrim) throw new Error('settings dialog did not render its close button');
      const rect = close.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const dragLanes = [...document.querySelectorAll('*')]
        .filter((element) => getComputedStyle(element).webkitAppRegion === 'drag')
        .map((element) => element.getBoundingClientRect())
        .filter((lane) => lane.width > 0 && lane.height > 0);
      const layers = [...document.elementsFromPoint(x, y)];
      const buttonIndex = layers.findIndex((layer) => layer === close || close.contains(layer));
      const hit = document.elementFromPoint(x, y);
      return {
        closeAppRegion: getComputedStyle(close).webkitAppRegion,
        scrimAppRegion: getComputedStyle(scrim).webkitAppRegion,
        // Only layers painted ABOVE the button can steal its clicks: the OS
        // subtracts the overlay's no-drag rect from every lane beneath it, and
        // elementsFromPoint is ordered topmost-first.
        dragLayerAbove: (buttonIndex === -1 ? layers : layers.slice(0, buttonIndex))
          .some((layer) => getComputedStyle(layer).webkitAppRegion === 'drag'),
        receivesHit: Boolean(hit && (hit === close || close.contains(hit))),
        // Proof the scenario is real at this viewport rather than hypothetical.
        overlapsDragLane: dragLanes.some((lane) => (
          lane.left < rect.right && lane.right > rect.left
          && lane.top < rect.bottom && lane.bottom > rect.top
        )),
      };
    });

    // The marker plus its descendant rule is what hands the clicks back.
    expect(hitTest.scrimAppRegion).toBe('no-drag');
    expect(hitTest.closeAppRegion).toBe('no-drag');
    expect(hitTest.dragLayerAbove).toBe(false);
    expect(hitTest.receivesHit).toBe(true);
    if (process.platform === 'win32') {
      // Windows is the only platform that draws the two-row band; elsewhere the
      // lanes are the 8px macOS strip and the canvas gutters, which the dialog's
      // own `p-6` padding already clears.
      expect(
        hitTest.overlapsDragLane,
        'the reported chrome-band overlap was not reproduced, so this test would pass vacuously',
      ).toBe(true);
    }

    // And the button still does its job.
    await closeButton.click();
    await expect(dialog).toBeHidden();
  });
});
