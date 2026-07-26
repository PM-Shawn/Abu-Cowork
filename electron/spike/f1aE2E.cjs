/**
 * F1a end-to-end IPC proof — boots a real Electron window with the PRODUCTION
 * preload + registerTauriHost, then from the RENDERER calls the persistence
 * commands via window.__TAURI_INTERNALS__.invoke (the exact path
 * conversationStorage.ts / atomicFs.ts use), and verifies the bytes landed on
 * disk. This exercises the full chain that was silently stubbed:
 *   renderer invoke() → preload → ipc 'tauri:invoke' → tauriHost → fsDispatch → fs
 *
 * Run: npx electron electron/spike/f1aE2E.cjs   (self-exits, prints JSON)
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { registerTauriHost } = require('../tauriHost.cjs');

app.on('window-all-closed', () => app.quit());

app.whenReady().then(async () => {
  registerTauriHost(app);
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // A scratch target under $HOME (an allowed scope root), isolated from real data.
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.f1a-e2e-'));
  const jsonl = path.join(dir, 'conv', 'messages.jsonl').replace(/\\/g, '/');
  const settings = path.join(dir, 'settings.json').replace(/\\/g, '/');

  // Drive the SAME invoke() the frontend uses, from the renderer context.
  const result = await win.webContents.executeJavaScript(`(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    await invoke('append_file_text', { path: ${JSON.stringify(jsonl)}, data: '{"id":"m1"}\\n' });
    await invoke('append_file_text', { path: ${JSON.stringify(jsonl)}, data: '{"id":"m2"}\\n' });
    await invoke('atomic_write_text', { path: ${JSON.stringify(settings)}, content: '{"theme":"dark"}' });
    const bk = await invoke('atomic_write_with_backup', { path: ${JSON.stringify(settings)}, content: '{"theme":"light"}' });
    return { bk };
  })()`);

  const report = {
    jsonlOnDisk: fs.existsSync(jsonl) ? fs.readFileSync(jsonl, 'utf8') : '<MISSING>',
    settingsOnDisk: fs.existsSync(settings) ? fs.readFileSync(settings, 'utf8') : '<MISSING>',
    backupPath: result.bk && result.bk.backup_path,
    backupOnDisk:
      result.bk && result.bk.backup_path && fs.existsSync(result.bk.backup_path)
        ? fs.readFileSync(result.bk.backup_path, 'utf8')
        : '<MISSING>',
  };
  const passed =
    report.jsonlOnDisk === '{"id":"m1"}\n{"id":"m2"}\n' &&
    report.settingsOnDisk === '{"theme":"light"}' &&
    report.backupOnDisk === '{"theme":"dark"}';

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('[f1a-e2e] ' + JSON.stringify({ passed, ...report }));
  app.exit(passed ? 0 : 1);
});
