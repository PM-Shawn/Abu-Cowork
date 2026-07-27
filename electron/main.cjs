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
const { registerTauriHost, wireWindowEvents, getMainWindow, emitEvent } = require('./tauriHost.cjs');
const { sidecarBundleExists, sidecarPathFor } = require('./appEnv.cjs');
const { initDeepLink, handleSecondInstanceArgv } = require('./deepLinkHost.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const FRONTEND_INDEX = path.join(REPO_ROOT, 'dist-electron-spike', 'index.html');
const PLACEHOLDER_INDEX = path.join(__dirname, 'renderer', 'index.html');

// E2E launches can redirect the dev shell's app-data parent before Electron
// initializes any path-backed service. This remains main-process-only: the
// renderer receives no control over it, and packaged builds always use their
// normal appData location.
const E2E_APP_DATA_ROOT_ENV = 'ABU_E2E_APP_DATA_ROOT';
if (!app.isPackaged && Object.hasOwn(process.env, E2E_APP_DATA_ROOT_ENV)) {
  const appDataRoot = process.env[E2E_APP_DATA_ROOT_ENV];
  if (typeof appDataRoot !== 'string' || !path.isAbsolute(appDataRoot)) {
    throw new Error(`${E2E_APP_DATA_ROOT_ENV} must be an absolute path when set`);
  }
  app.setPath('appData', appDataRoot);
}

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
    // Only the drag region's OWN empty space moves the window; EVERY descendant
    // is no-drag so it stays clickable. Tauri's data-tauri-drag-region behaves
    // this way (interactive children keep working) — the previous version only
    // excluded button/input/a, so the workspace TABS (plain divs) inherited the
    // drag region and showed the window-move cursor / were hard to click.
    void win.webContents.insertCSS(
      '[data-tauri-drag]{-webkit-app-region:drag}[data-tauri-drag] *{-webkit-app-region:no-drag}'
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

// Single-instance lock (Tauri had tauri_plugin_single_instance; this is its
// Electron equivalent). Without it, every launch — dock re-click, `open`,
// deep-link, `npm run electron:dev` — spawns a SEPARATE app + sidecar, and N
// instances then fight over the one data dir (dropped/swallowed messages, DB
// contention). With it, a second launch just focuses the existing window and
// exits, so there is always exactly one instance.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Deep-link wiring (abu://enroll → enterprise-bind pre-fill). MUST be set up
  // before app 'ready' so the early open-url listener is in place when the OS
  // delivers a launching URL, and the cold-start argv is parsed. See
  // electron/deepLinkHost.cjs for the competitor-grounded design.
  initDeepLink(app, { emitEvent, getMainWindow });

  app.on('second-instance', (_event, commandLine) => {
    const existing = getMainWindow() || BrowserWindow.getAllWindows()[0];
    if (existing) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
    }
    // Win/Linux running-app deep link: the OS launched a second instance whose
    // argv carries the URL; forward it to the deep-link host to emit/queue.
    handleSecondInstanceArgv(commandLine);
  });

  app.whenReady().then(() => {
  registerTauriHost(app);
  // Preflight: the frontend spawns the sidecar via mcp_spawn, so a missing
  // bundle would surface only as an opaque child ENOENT — warn clearly here.
  if (!sidecarBundleExists(app)) {
    log('warn', 'sidecar bundle missing — the frontend will fail to start it; run `npm run build:sidecar`', {
      path: sidecarPathFor(app),
    });
  }
  createWindow();
  app.on('activate', () => {
    // Dock-icon click / reactivation. Target the tracked MAIN window
    // specifically — NOT BrowserWindow.getAllWindows()[0], which since the GUI
    // families landed may be the pet / overlay (small, transparent) window, so
    // showing that left the main UI hidden. window_hide (closeAction 'minimize')
    // hides rather than destroys the main window, so it's still there to show.
    const mainWin = getMainWindow();
    if (mainWin) {
      mainWin.show();
      mainWin.focus();
    } else {
      createWindow();
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
} // end single-instance-lock else
