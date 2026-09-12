/**
 * Real-Electron journeys for two Tauri-shaped window calls the Electron shell
 * used to drop on the floor:
 *
 *  1. The desktop pet remembers where it was left. The pet window persists its
 *     position from `getCurrentWindow().onMoved` (`tauri://move`) and restores
 *     it with `setPosition` (`plugin:window|set_position`); Electron emitted no
 *     move event and had no set_position handler, so the pet reopened at the
 *     bottom-right corner on every launch.
 *  2. A notification click brings the main window forward. It calls
 *     `show()` / `unminimize()` / `setFocus()`, which had no handler and were
 *     silently stubbed to null.
 *
 * The pet is moved from the main process with BrowserWindow.setPosition — the
 * same call the Electron drag stand-in (start_dragging) makes on every cursor
 * tick, so it takes the same 'move' → `tauri://move` path as a real drag.
 */
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import {
  closeAbuElectron,
  createElectronDataRoot,
  dismissFirstRunOverlays,
  firstShowRecordFor,
  launchAbuElectron,
  removeElectronDataRoot,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;
const CHAT_PLACEHOLDER = '想让阿布帮你做点什么？';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function waitForApp(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
}

async function petBounds(app: ElectronApplication): Promise<Rect | null> {
  return app.evaluate(({ BrowserWindow }) => {
    const pet = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/pet.html'));
    return pet && pet.isVisible() ? pet.getBounds() : null;
  });
}

async function persistedPetPosition(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem('abu-settings');
    return raw ? (JSON.parse(raw) as { state: Record<string, unknown> }).state.petPosition ?? null : null;
  });
}

/** Unlock the pet experiment and open the pet, the way App.tsx boot restores it. */
async function enablePet(page: Page): Promise<void> {
  await page.evaluate(() => {
    const raw = window.localStorage.getItem('abu-settings');
    if (!raw) throw new Error('abu-settings was not initialized before enabling the pet');
    const persisted = JSON.parse(raw) as { state: Record<string, unknown>; version: number };
    persisted.state.labs = { ...(persisted.state.labs as Record<string, boolean> | undefined), pet: true };
    persisted.state.petOpen = true;
    window.localStorage.setItem('abu-settings', JSON.stringify(persisted));
  });
  await page.reload();
  await waitForApp(page);
}

test('the desktop pet reopens where it was left, without a jump', async () => {
  const dataRoot = createElectronDataRoot();
  try {
    let launched = await launchAbuElectron(dataRoot);
    let target: { x: number; y: number };
    let expectedPhysical: { x: number; y: number };
    try {
      const main = await launched.app.firstWindow();
      await waitForApp(main);
      await dismissFirstRunOverlays(main);
      await enablePet(main);
      await expect.poll(() => petBounds(launched.app), { timeout: 20_000 }).not.toBeNull();

      // A spot well inside the primary work area, away from the snap edges, so
      // edge-snap leaves it untouched.
      const display = await launched.app.evaluate(({ screen }) => {
        const d = screen.getPrimaryDisplay();
        return { workArea: d.workArea, scaleFactor: d.scaleFactor };
      });
      target = { x: display.workArea.x + 240, y: display.workArea.y + 180 };
      expectedPhysical = {
        x: Math.round(target.x * display.scaleFactor),
        y: Math.round(target.y * display.scaleFactor),
      };
      await launched.app.evaluate(({ BrowserWindow }, to) => {
        const pet = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/pet.html'));
        if (!pet) throw new Error('pet window missing');
        pet.setPosition(to.x, to.y);
      }, target);

      // The pet debounces move events (220 ms), then persists in physical px.
      await expect.poll(() => persistedPetPosition(main), { timeout: 10_000 }).toEqual(expectedPhysical);

      // Any later settings write from the MAIN window (opening Settings is one)
      // must not overwrite the pet's position with the main window's copy.
      await main.getByRole('button', { name: /^(我|Me)$/ }).click();
      await main.getByRole('menuitem', { name: /^(设置|Settings)$/ }).click();
      await main.keyboard.press('Escape');
      await expect.poll(() => persistedPetPosition(main), { timeout: 3_000 }).toEqual(expectedPhysical);
    } finally {
      await closeAbuElectron(launched.app);
    }

    // `recordWindowShows` injects the first-show recorder into the main process
    // ahead of electron/main.cjs, so it is watching before the app can create a
    // single window. Installing that hook from here instead — after
    // electron.launch() resolves — races the app's own startup, which is what
    // made this journey report a missing pet window on ~40% of CI runs.
    launched = await launchAbuElectron(dataRoot, { recordWindowShows: true });
    try {
      const main = await launched.app.firstWindow();
      await waitForApp(main);
      await expect.poll(() => petBounds(launched.app), { timeout: 20_000 }).not.toBeNull();
      await expect
        .poll(async () => {
          const b = await petBounds(launched.app);
          return b ? Math.max(Math.abs(b.x - target.x), Math.abs(b.y - target.y)) : Infinity;
        }, { timeout: 10_000 })
        .toBeLessThanOrEqual(1);
      // …and it was already there when it first became visible: the host creates
      // the pet window AT the saved spot (guiHost.cjs initialPetPosition), so a
      // regression that let the renderer move it after first paint would show up
      // here as the default bottom-right corner.
      const firstShow = await firstShowRecordFor(launched.app, '/pet.html');
      expect(firstShow, 'the recorder saw the pet window being created').not.toBeNull();
      expect(firstShow!.shownBounds, 'the pet window was shown during this launch').not.toBeNull();
      expect(Math.abs(firstShow!.shownBounds!.x - target.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(firstShow!.shownBounds!.y - target.y)).toBeLessThanOrEqual(1);
    } finally {
      await closeAbuElectron(launched.app);
    }
  } finally {
    removeElectronDataRoot(dataRoot);
  }
});

test('show, unminimize and setFocus from the main window reach a real handler', async () => {
  const dataRoot = createElectronDataRoot();
  const { app } = await launchAbuElectron(dataRoot);
  const unhandled: string[] = [];
  app.on('console', (msg) => {
    if (msg.text().includes('UNHANDLED COMMAND')) unhandled.push(msg.text());
  });
  try {
    const main = await app.firstWindow();
    await waitForApp(main);
    const invokeWindow = (cmd: string) =>
      main.evaluate(async (command) => {
        const internals = (window as Window & {
          __TAURI_INTERNALS__?: { invoke: (c: string, a?: unknown) => Promise<unknown> };
        }).__TAURI_INTERNALS__;
        if (!internals) throw new Error('Tauri bridge missing');
        // The exact args @tauri-apps/api/window sends for these three methods.
        return internals.invoke(command, { label: 'main' });
      }, cmd);
    const mainState = () =>
      app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('/index.html'));
        return w ? { minimized: w.isMinimized(), visible: w.isVisible() } : null;
      });

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('/index.html'))?.minimize();
    });
    await expect.poll(async () => (await mainState())?.minimized, { timeout: 5_000 }).toBe(true);
    await invokeWindow('plugin:window|unminimize');
    await expect.poll(async () => (await mainState())?.minimized, { timeout: 5_000 }).toBe(false);

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('/index.html'))?.hide();
    });
    await expect.poll(async () => (await mainState())?.visible, { timeout: 5_000 }).toBe(false);
    await invokeWindow('plugin:window|show');
    await expect.poll(async () => (await mainState())?.visible, { timeout: 5_000 }).toBe(true);

    await invokeWindow('plugin:window|set_focus');
    expect(unhandled, 'no window command fell through to the parity-gap stub').toEqual([]);
  } finally {
    await closeAbuElectron(app);
    removeElectronDataRoot(dataRoot);
  }
});
