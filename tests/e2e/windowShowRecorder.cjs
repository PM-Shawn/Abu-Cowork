'use strict';

/**
 * Main-process recorder for "where was this window when it FIRST became
 * visible", used by tests/e2e/pet-position.spec.ts.
 *
 * It is injected with Electron's `-r` flag AHEAD of electron/main.cjs (see
 * `recordWindowShows` in tests/e2e/electronHelpers.ts), so the
 * `browser-window-created` hook is installed before the app has loaded its
 * entry point and therefore before any window can exist.
 *
 * Installing the same hook from the test side instead — an `app.evaluate()`
 * after `electron.launch()` resolves — is a race, and it is the race that made
 * the pet-position journey fail on roughly 40% of CI runs with "the pet window
 * was shown during this launch". Playwright's Electron loader defers the app's
 * `ready` event until `launch()` is finishing (playwright-core
 * server/electron/loader.js), so the app's whole startup — main window, its
 * renderer boot, and the `pet_show` IPC that renderer sends — runs concurrently
 * with the test's first evaluate. When the evaluate lost that race the pet
 * window had already been created, `browser-window-created` never fired for it,
 * and the assertion reported a missing window rather than a real regression.
 *
 * Records are keyed by `BrowserWindow.id`, which is assigned at construction,
 * rather than by `webContents.getURL()` sampled inside the `show` handler — the
 * URL is only settled once the window's navigation has committed, which is not
 * guaranteed at first show (`showWhenReady` in electron/guiHost.cjs reveals a
 * window on a timeout when `ready-to-show` never arrives).
 */

const { app } = require('electron');

/** @type {{ id: number, shownBounds: import('electron').Rectangle | null, shownUrl: string | null }[]} */
const records = [];
globalThis.__abuWindowShowRecords = records;

app.on('browser-window-created', (_event, win) => {
  const record = { id: win.id, shownBounds: null, shownUrl: null };
  records.push(record);
  win.once('show', () => {
    if (win.isDestroyed()) return;
    record.shownBounds = win.getBounds();
    record.shownUrl = win.webContents.getURL();
  });
});
