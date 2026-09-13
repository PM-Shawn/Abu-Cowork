'use strict';

/**
 * Main-process recorders for the real-Electron E2E suite. Installed by
 * tests/e2e/mainProcessRecorder.cjs, which Electron loads with `-r` AHEAD of
 * electron/main.cjs (see `recordMainProcess` in tests/e2e/electronHelpers.ts),
 * so both hooks are in place before the app can create a window or a renderer
 * can send its first IPC. Pure functions over injected `app` / `ipcMain` so the
 * contract is unit-tested in mainProcessRecorderCore.test.cjs.
 */

/**
 * @typedef {{ x: number, y: number, width: number, height: number }} Rectangle
 * @typedef {{
 *   id: number,
 *   shownBounds: Rectangle | null,
 *   shownUrl: string | null,
 *   shownVia: 'constructor' | 'show' | 'showInactive' | 'show-event' | null,
 * }} WindowShowRecord
 */

/**
 * Record where every window is the moment it is FIRST revealed, keyed by
 * `BrowserWindow.id` (assigned at construction).
 *
 * The reveal is captured when the app CALLS `show()` / `showInactive()` — the
 * window's own methods are wrapped on the instance inside
 * `browser-window-created` — not when Electron later emits the `show` event.
 * On macOS the two are not the same moment: `NativeWindowMac::Show()` only
 * orders the NSWindow front, and the `show` event is emitted from the
 * `windowDidChangeOcclusionState:` delegate (electron_ns_window_delegate.mm)
 * once the window server reports the window non-occluded — a later run-loop
 * pass, 30-100 ms after the call on an idle Mac and unbounded on a loaded CI
 * runner, while `isVisible()` flips true synchronously. A recorder keyed on
 * the event therefore reports "never shown" whenever a test reads it in that
 * gap, which is what made pet-position.spec.ts red on ~1 in 3 CI runs after
 * its record-installation race had already been fixed (#487).
 *
 * A window constructed with `show: true` is revealed inside the constructor,
 * before `browser-window-created` fires, so it is recorded from that event
 * with its creation bounds. Any reveal path that is neither (`restore()` on a
 * window minimized at creation, …) still lands via the `show` event, as a
 * fallback only.
 *
 * `shownUrl` is informational: at first reveal the navigation may not have
 * committed (`showWhenReady` in electron/guiHost.cjs reveals on a timeout when
 * `ready-to-show` never arrives), so callers match live windows by URL and
 * look the record up by id (electronHelpers.ts firstShowRecordFor).
 *
 * @param {import('electron').App} app
 * @returns {WindowShowRecord[]}
 */
function installWindowShowRecorder(app) {
  /** @type {WindowShowRecord[]} */
  const records = [];
  app.on('browser-window-created', (_event, win) => {
    /** @type {WindowShowRecord} */
    const record = { id: win.id, shownBounds: null, shownUrl: null, shownVia: null };
    records.push(record);

    const capture = (via) => {
      if (record.shownVia !== null || win.isDestroyed()) return;
      record.shownBounds = win.getBounds();
      record.shownUrl = win.webContents.getURL();
      record.shownVia = via;
    };

    if (win.isVisible()) capture('constructor');

    for (const method of /** @type {const} */ (['show', 'showInactive'])) {
      const original = win[method];
      win[method] = (...args) => {
        capture(method);
        return original.apply(win, args);
      };
    }

    win.once('show', () => capture('show-event'));
  });
  return records;
}

/**
 * @typedef {{ webContentsId: number, event: string }} EventListenRecord
 */

/**
 * Record every `plugin:event|listen` a renderer registers through the Tauri
 * bridge (`ipcMain.handle('tauri:invoke', …)` in electron/tauriHost.cjs), in
 * arrival order. `ipcMain.handle` is wrapped before main.cjs registers its
 * handler; the wrapper observes the payload and forwards the call untouched,
 * so sender trust checks and return values are the product's own.
 *
 * Why a test needs this: main-process window events (`tauri://move`, …) are
 * delivered only to subscriptions that already exist (tauriHost `deliver`),
 * exactly like Tauri. A spec that moves a window right after it becomes
 * visible is racing the renderer's `listen()` round-trip; the deterministic
 * precondition is "this renderer has registered that listener", which is what
 * electronHelpers.ts `windowListenerRegistered` polls from these records.
 *
 * @param {Pick<import('electron').IpcMain, 'handle'>} ipcMain
 * @returns {EventListenRecord[]}
 */
function installEventListenRecorder(ipcMain) {
  /** @type {EventListenRecord[]} */
  const listens = [];
  const originalHandle = ipcMain.handle;
  ipcMain.handle = function recordedHandle(channel, listener) {
    if (channel !== 'tauri:invoke') return originalHandle.call(this, channel, listener);
    return originalHandle.call(this, channel, function recordedInvoke(event, payload, ...rest) {
      if (payload && typeof payload === 'object' && payload.cmd === 'plugin:event|listen') {
        const name = payload.args && typeof payload.args === 'object' ? payload.args.event : undefined;
        if (typeof name === 'string') listens.push({ webContentsId: event.sender.id, event: name });
      }
      return listener.call(this, event, payload, ...rest);
    });
  };
  return listens;
}

module.exports = { installWindowShowRecorder, installEventListenRecorder };
