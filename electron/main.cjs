/**
 * Electron main process — Phase 2 slice A dev shell.
 *
 * Loads the real Abu frontend (built with a relative base into
 * dist-electron-spike/, falling back to the slice-1 placeholder if that
 * build is absent) behind the production Tauri-IPC bridge (preload.cjs +
 * tauriHost.cjs) + the sidecar supervisor. Launch with `npm run electron:dev`.
 *
 * Security posture: contextIsolation on, nodeIntegration off, sandbox ON.
 * A sandboxed preload can still require('electron') for ipcRenderer/contextBridge
 * (only Node built-ins like fs/path/os are withheld), and preload.cjs uses
 * nothing else — so the OS renderer sandbox stays on. This matters: Abu renders
 * AI-generated inline-HTML widgets and loaded web pages, so a renderer-side RCE
 * must stay confined by the OS sandbox.
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { SidecarSupervisor } = require('./sidecarSupervisor.cjs');
const { resolveSidecarLaunch, sidecarBundleExists, SIDECAR_PATH } = require('./appEnv.cjs');
const { registerTauriHost } = require('./tauriHost.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const FRONTEND_INDEX = path.join(REPO_ROOT, 'dist-electron-spike', 'index.html');
const PLACEHOLDER_INDEX = path.join(__dirname, 'renderer', 'index.html');

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
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const hasFrontend = fs.existsSync(FRONTEND_INDEX);
  if (!hasFrontend) {
    log('warn', 'built frontend missing, loading placeholder', {
      expected: FRONTEND_INDEX,
      hint: 'npx vite build --base=./ --outDir dist-electron-spike',
    });
  }
  void win.loadFile(hasFrontend ? FRONTEND_INDEX : PLACEHOLDER_INDEX);
}

app.whenReady().then(() => {
  registerTauriHost(app);
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
