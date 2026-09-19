'use strict';

/**
 * `-r` entry for the E2E main-process instrumentation, injected AHEAD of
 * electron/main.cjs by `launchAbuElectron(root, { recordMainProcess: true })`.
 *
 * It has to be a `-r` module: installing the window hook from the test side
 * after `electron.launch()` resolves races the app's own startup. Playwright's
 * Electron loader defers `app.ready` until `launch()` is finishing, so the
 * main window, its renderer boot and the `pet_show` IPC that renderer sends
 * all run concurrently with the test's first evaluate; when the evaluate lost,
 * `browser-window-created` had already fired for the pet window and the spec
 * reported a missing window on ~40% of CI runs (#487).
 */

const { app } = require('electron');
const { installWindowShowRecorder } = require('./mainProcessRecorderCore.cjs');

globalThis.__abuWindowShowRecords = installWindowShowRecorder(app);

// The main process's own tauriHost instance, for helpers that read its live
// state from `app.evaluate()` — which has no `require` in scope. Lazy on
// purpose: main.cjs loads tauriHost itself, and a query only runs after boot.
globalThis.__abuTauriHostForE2E = () => require('../../electron/tauriHost.cjs');
