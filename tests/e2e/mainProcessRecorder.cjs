'use strict';

/**
 * `-r` entry for the E2E main-process recorders (see mainProcessRecorderCore.cjs
 * for what they capture and why). Injected AHEAD of electron/main.cjs by
 * `launchAbuElectron(root, { recordMainProcess: true })`, so the window hook
 * is installed before the app can create a single window and the IPC hook
 * before any renderer can register a listener. Installing either from the test
 * side after `electron.launch()` resolves races the app's own startup:
 * Playwright's Electron loader defers `app.ready` until `launch()` is
 * finishing, so the whole boot runs concurrently with the test's first
 * evaluate (the original ~40% CI flake, #487).
 */

const { app, ipcMain } = require('electron');
const { installWindowShowRecorder, installEventListenRecorder } = require('./mainProcessRecorderCore.cjs');

globalThis.__abuWindowShowRecords = installWindowShowRecorder(app);
globalThis.__abuEventListenRecords = installEventListenRecorder(ipcMain);
