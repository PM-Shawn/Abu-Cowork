'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const preload = path.join(__dirname, '..', 'preload.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-preload-migration-'));
const page = path.join(root, 'index.html');
const migratedValue = '{"state":{"source":"tauri"},"version":42}';
let acknowledgement = null;

fs.writeFileSync(
  page,
  `<!doctype html><meta charset="utf-8"><script>
    window.valueAtFirstPageScript = localStorage.getItem('abu-settings');
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
    assert.deepEqual(acknowledgement, {
      imported: ['abu-settings'],
      overwritten: [],
      skippedExisting: [],
      failed: [],
      previous: [],
    });
    process.stdout.write('Electron preload migration verified before page scripts.\n');
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
