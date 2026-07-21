/**
 * Electron main process — Phase 2 slice 1 dev shell.
 *
 * Minimal shell: one BrowserWindow loading a placeholder page (frontend
 * integration is a later slice) + the sidecar supervisor. Proves the Electron
 * shell can host the same sidecar bundle the Tauri shell runs. Launch with
 * `npm run electron:dev`.
 *
 * Security posture even for the placeholder: contextIsolation on, nodeIntegration
 * off, sandbox on — the renderer gets no Node. (No preload/IPC yet — nothing to
 * bridge until the frontend lands.)
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { SidecarSupervisor } = require('./sidecarSupervisor.cjs');
const { resolveSidecarLaunch, sidecarBundleExists, SIDECAR_PATH } = require('./appEnv.cjs');

// Isolate this dev shell's user-data dir from any other Electron/Abu app.
app.setName('abu-electron-dev');

/** @type {SidecarSupervisor | null} */
let supervisor = null;

function log(level, msg, extra) {
  const line = `[electron:${level}] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`;
  (level === 'error' ? console.error : console.log)(line);
}

function startSidecar() {
  if (!sidecarBundleExists()) {
    log('error', 'sidecar bundle missing — run `npm run build:sidecar` first', { path: SIDECAR_PATH });
    return;
  }
  const launch = resolveSidecarLaunch(app);
  supervisor = new SidecarSupervisor({ ...launch, log });
  supervisor.start();
  log('info', 'sidecar supervisor started', { pid: supervisor.getSidecarPid(), status: supervisor.getStatus() });

  // Quick liveness proof in the dev console (mirrors the acceptance round-trip).
  void (async () => {
    try {
      const pong = await supervisor.request('ping');
      log('info', 'sidecar ping ok', { pong });
    } catch (err) {
      log('warn', 'sidecar ping failed', { error: err instanceof Error ? err.message : String(err) });
    }
  })();
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    backgroundColor: '#1a1a1a',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  startSidecar();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// No orphan: kill the sidecar before the shell exits.
app.on('will-quit', (event) => {
  if (supervisor && supervisor.getStatus() !== 'stopped') {
    event.preventDefault();
    void supervisor.stop().finally(() => {
      supervisor = null;
      app.quit();
    });
  }
});

app.on('window-all-closed', () => {
  // macOS convention keeps the app alive; here we quit so the sidecar is torn
  // down (dev ergonomics — closing the window ends the session).
  app.quit();
});
