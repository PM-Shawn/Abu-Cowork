'use strict';
// Test-only, hidden settings reader. Never load the application renderer or
// launch the source profile. The launcher supplies an isolated Chromium copy.
const { app, BrowserWindow, protocol, session, safeStorage } = require('electron');
const fs = require('node:fs');
const { selectSavedEvalConfig } = require('./computer-use-saved-config.cjs');

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: details.url !== 'file:///abu-cu-read-settings.html' });
  });
  await protocol.handle('file', () => new Response('<!doctype html><title>Isolated settings reader</title>'));
  const win = new BrowserWindow({ show: false, webPreferences: {
    nodeIntegration: false, contextIsolation: true, sandbox: true,
  } });
  globalThis.__cuReadSavedConfig = async () => {
    try {
      const settings = JSON.parse(await win.webContents.executeJavaScript("localStorage.getItem('abu-settings')"));
      return selectSavedEvalConfig(settings, (key) => {
        if (!safeStorage.isEncryptionAvailable()) throw new Error();
        const encrypted = JSON.parse(fs.readFileSync(process.env.ABU_CU_SAVED_SECRETS, 'utf8'));
        if (typeof encrypted[key] !== 'string') throw new Error();
        return safeStorage.decryptString(Buffer.from(encrypted[key], 'base64'));
      });
    } catch { throw new Error('saved-eval-configuration-unavailable'); }
  };
  await win.loadURL('file:///abu-cu-read-settings.html');
}).catch(() => app.exit(2));
