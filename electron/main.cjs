/**
 * Electron main process — Phase 2 dev shell.
 *
 * Loads the real Abu frontend (built with a relative base into
 * dist-electron-spike/, falling back to the slice-1 placeholder if that build
 * is absent) behind the production Tauri-IPC bridge (preload.cjs + tauriHost.cjs,
 * which now includes the generic mcp_* process bridge). Launch with
 * `npm run electron:dev`.
 *
 * Sidecar ownership (mcp 收敛): main does NOT spawn/supervise the agent sidecar
 * itself — the FRONTEND's own sidecarManager drives it via mcp_spawn/mcp_write/
 * mcp_kill (routed to electron/mcpBridge.cjs), exactly as it did on Tauri. This
 * avoids two supervisors fighting over one sidecar. The standalone
 * SidecarSupervisor (electron/sidecarSupervisor.cjs) + `npm run electron:test`
 * remain as a tested component but are no longer auto-started here.
 * No-orphan on quit is handled by mcpBridge's process 'exit' guard.
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
const { registerTauriHost, wireWindowEvents } = require('./tauriHost.cjs');
const { sidecarBundleExists, SIDECAR_PATH } = require('./appEnv.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const FRONTEND_INDEX = path.join(REPO_ROOT, 'dist-electron-spike', 'index.html');
const PLACEHOLDER_INDEX = path.join(__dirname, 'renderer', 'index.html');

// Isolate this dev shell's user-data dir from any other Electron/Abu app.
app.setName('abu-electron-dev');

function log(level, msg, extra) {
  const line = `[electron:${level}] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`;
  (level === 'error' ? console.error : console.log)(line);
}

function createWindow() {
  const isMac = process.platform === 'darwin';
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    backgroundColor: '#faf9f5',
    // Match Tauri (tauri.conf.json: titleBarStyle "Overlay" + trafficLightPosition
    // {x:20,y:31}): hide the native title bar and overlay the macOS traffic
    // lights ON the content, so the frontend's own top bar isn't doubled by a
    // separate native title-bar strip. The frontend already reserves the
    // top-left space for the traffic lights (it was built for this layout).
    ...(isMac ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 20, y: 27 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Tauri drag regions use the [data-tauri-drag] attribute; under Electron a
  // window is dragged via CSS `-webkit-app-region`. Map them so the top bar
  // moves the window (interactive children stay clickable via no-drag).
  win.webContents.on('did-finish-load', () => {
    void win.webContents.insertCSS(
      '[data-tauri-drag]{-webkit-app-region:drag}' +
        '[data-tauri-drag] button,[data-tauri-drag] input,[data-tauri-drag] a,' +
        '[data-tauri-drag] [role="button"],[data-tauri-drag] [contenteditable]{-webkit-app-region:no-drag}'
    );
  });
  const hasFrontend = fs.existsSync(FRONTEND_INDEX);
  if (!hasFrontend) {
    log('warn', 'built frontend missing, loading placeholder', {
      expected: FRONTEND_INDEX,
      hint: 'npx vite build --base=./ --outDir dist-electron-spike',
    });
  }

  // Wire window lifecycle → Tauri event/close contract (focus/blur, preventable
  // close with the isQuitting + has-listener guards, reload subscription purge).
  // Shared with the boot-verify harness so both exercise identical wiring.
  wireWindowEvents(win);

  void win.loadFile(hasFrontend ? FRONTEND_INDEX : PLACEHOLDER_INDEX);
}

app.whenReady().then(() => {
  registerTauriHost(app);
  // Preflight: the frontend spawns the sidecar via mcp_spawn, so a missing
  // bundle would surface only as an opaque child ENOENT — warn clearly here.
  if (!sidecarBundleExists()) {
    log('warn', 'sidecar bundle missing — the frontend will fail to start it; run `npm run build:sidecar`', {
      path: SIDECAR_PATH,
    });
  }
  createWindow();
  app.on('activate', () => {
    // window_hide (closeAction: 'minimize') hides rather than destroys the
    // window, so on macOS dock-icon reactivation there IS an existing window
    // — show it instead of spawning a second one. Only createWindow() when
    // none exists at all (e.g. after a real quit that somehow re-activates).
    const existing = BrowserWindow.getAllWindows()[0];
    if (!existing) {
      createWindow();
    } else {
      existing.show();
      existing.focus();
    }
    // TODO(slice E): Windows/Linux minimize-to-tray restore needs a tray
    // (no dock/activate equivalent there) — out of scope for slice D.
  });
});

app.on('window-all-closed', () => {
  // macOS convention keeps the app alive; here we quit so the frontend-driven
  // sidecar (killed by mcpBridge's exit guard) is torn down — dev ergonomics.
  app.quit();
});
