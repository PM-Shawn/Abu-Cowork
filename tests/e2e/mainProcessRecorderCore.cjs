'use strict';

/**
 * First-reveal recorder for the real-Electron E2E suite. Installed by
 * tests/e2e/mainProcessRecorder.cjs, which Electron loads with `-r` AHEAD of
 * electron/main.cjs (see `recordMainProcess` in tests/e2e/electronHelpers.ts),
 * so the hook is in place before the app can create a window. A pure function
 * over an injected `app`, unit-tested in mainProcessRecorderCore.test.cjs.
 */

/**
 * @typedef {{ x: number, y: number, width: number, height: number }} Rectangle
 * @typedef {{ id: number, shownBounds: Rectangle | null }} WindowShowRecord
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
 * the event reports "never shown" whenever a test reads it in that gap, which
 * is what kept pet-position.spec.ts red on ~1 in 3 CI runs after its
 * hook-installation race had already been fixed (#487).
 *
 * Bounds are read AFTER the wrapped call returns: AppKit constrains a frame
 * onto the screen synchronously inside the reveal (a window created under the
 * menu bar comes back at the menu bar's edge), so this is where the window was
 * presented, not where it was requested — still before any event or IPC can
 * run.
 *
 * A window constructed with `show: true` is revealed inside the constructor
 * (Electron's NativeWindow::InitFromOptions calls Show() before the JS
 * constructor emits `browser-window-created`), so it is recorded from that
 * event. Any other reveal path is deliberately NOT covered: a record left at
 * `shownBounds: null` while `isVisible()` is true means a reveal the recorder
 * cannot capture synchronously, and a spec should fail on that rather than
 * silently fall back to the asynchronous event.
 *
 * @param {import('electron').App} app
 * @returns {WindowShowRecord[]}
 */
function installWindowShowRecorder(app) {
  /** @type {WindowShowRecord[]} */
  const records = [];
  app.on('browser-window-created', (_event, win) => {
    /** @type {WindowShowRecord} */
    const record = { id: win.id, shownBounds: null };
    records.push(record);

    const capture = () => {
      if (record.shownBounds !== null || win.isDestroyed()) return;
      record.shownBounds = win.getBounds();
    };

    if (win.isVisible()) capture();

    for (const method of ['show', 'showInactive']) {
      const original = win[method];
      win[method] = (...args) => {
        const result = original.apply(win, args);
        capture();
        return result;
      };
    }
  });
  return records;
}

module.exports = { installWindowShowRecorder };
