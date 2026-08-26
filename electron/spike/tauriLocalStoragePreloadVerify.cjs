'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { resolveDeviceId } = require('../deviceIdStore.cjs');

const preload = path.join(__dirname, '..', 'preload.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-preload-migration-'));
const page = path.join(root, 'index.html');
const migratedValue = '{"state":{"source":"tauri"},"version":42}';
let acknowledgement = null;

fs.writeFileSync(
  page,
  `<!doctype html><meta charset="utf-8"><script>
    window.valueAtFirstPageScript = localStorage.getItem('abu-settings');
    window.deviceIdAtFirstPageScript = localStorage.getItem('abu_device_id');
  </script>`,
  'utf8'
);

ipcMain.on('abu:tauri-local-storage:get', (event) => {
  event.returnValue = {
    version: 2,
    conflictPolicy: 'source-wins',
    items: [{ key: 'abu-settings', value: migratedValue }],
  };
});
ipcMain.on('abu:tauri-local-storage:ack', (event, result) => {
  acknowledgement = result;
  event.returnValue = { ok: true };
});
// preload sendSyncs on this channel too. Registering it here is not optional
// politeness: an unlistened sendSync leaves the renderer depending on
// Electron's no-listener behavior, which this harness has no business
// exercising — and it is the one mechanism by which the device-id step could
// stall a boot. Uses the real resolver so the assertion below covers the
// production path, not a stub.
ipcMain.on('abu:device-id:resolve', (event, request) => {
  event.returnValue = resolveDeviceId({ dir: root, localStorageId: request?.localStorageId });
});
ipcMain.on('tauri:os-internals', (event) => {
  event.returnValue = {
    platform: process.platform,
    arch: process.arch,
    family: process.platform === 'win32' ? 'windows' : 'unix',
    version: os.release(),
    type: os.type(),
    eol: os.EOL,
  };
});

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      partition: `abu-transition-preload-${process.pid}`,
    },
  });
  try {
    await win.loadFile(page);
    const valueAtFirstPageScript = await win.webContents.executeJavaScript(
      'window.valueAtFirstPageScript'
    );
    assert.equal(valueAtFirstPageScript, migratedValue);
    // The device id must be settled BEFORE page scripts run — that timing is
    // the whole reason reconciliation lives in preload and getDeviceId() could
    // stay synchronous.
    const deviceIdAtFirstPageScript = await win.webContents.executeJavaScript(
      'window.deviceIdAtFirstPageScript'
    );
    const persistedDeviceId = JSON.parse(
      fs.readFileSync(path.join(root, 'device-id.json'), 'utf8')
    ).deviceId;
    assert.equal(deviceIdAtFirstPageScript, persistedDeviceId);
    assert.deepEqual(acknowledgement, {
      imported: ['abu-settings'],
      overwritten: [],
      skippedExisting: [],
      failed: [],
      previous: [],
    });
    process.stdout.write('Electron preload migration and device id verified before page scripts.\n');
    app.exit(0);
  } catch (error) {
    process.stderr.write(
      `Electron preload migration failed: ${
        error instanceof Error ? error.stack || error.message : String(error)
      }\n`
    );
    app.exit(1);
  } finally {
    if (!win.isDestroyed()) win.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
