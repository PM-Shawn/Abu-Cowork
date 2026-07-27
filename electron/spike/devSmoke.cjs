/**
 * Dev smoke — opens a VISIBLE Electron window running the real production
 * wiring (preload + registerTauriHost + sidecar supervisor) loading the built
 * frontend, lets it settle, then captures a screenshot + DOM state + runtime
 * console so we can judge whether the frontend actually RENDERS and is usable
 * in Electron — the thing the windowless boot-verify can't tell us.
 *
 * Writes electron-results/dev-smoke.png + dev-smoke.json, then quits.
 * Run: npx electron electron/spike/devSmoke.cjs
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { SidecarSupervisor } = require('../sidecarSupervisor.cjs');
const { resolveSidecarLaunch, sidecarBundleExists } = require('../appEnv.cjs');
const { registerTauriHost, wireWindowEvents } = require('../tauriHost.cjs');
const { registerPrivilegedWindow } = require('../securityBoundary.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INDEX = path.join(REPO_ROOT, 'dist-electron-spike', 'index.html');
const OUT_PNG = path.join(REPO_ROOT, 'electron-results', 'dev-smoke.png');
const OUT_JSON = path.join(REPO_ROOT, 'electron-results', 'dev-smoke.json');
const SETTLE_MS = 12000;

app.on('window-all-closed', () => app.quit());

app.whenReady().then(async () => {
  registerTauriHost(app);

  // Start the real sidecar (frontend may talk to it during boot).
  let supervisor = null;
  if (sidecarBundleExists()) {
    supervisor = new SidecarSupervisor({ ...resolveSidecarLaunch(app), log: () => {} });
    supervisor.start();
  }

  const consoleLines = [];
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    ...(process.platform==="darwin"?{titleBarStyle:"hidden",trafficLightPosition:{x:20,y:27}}:{}),
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.webContents.on('console-message', (...a) => {
    const parts = a.slice(1).map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x)));
    consoleLines.push(parts.join(' '));
  });
  win.webContents.on('render-process-gone', (_e, d) => consoleLines.push('RENDER-GONE ' + JSON.stringify(d)));

  wireWindowEvents(win);
  registerPrivilegedWindow(win, INDEX, { label: 'dev-smoke' });

  try {
    await win.loadFile(INDEX);
  } catch (err) {
    consoleLines.push('LOAD-ERROR ' + String(err));
  }

  await new Promise((r) => setTimeout(r, SETTLE_MS));

  // What actually rendered? Inspect the DOM: is the error page showing, did the
  // React root mount real content, what visible text/structure is present.
  let dom = {};
  try {
    dom = await win.webContents.executeJavaScript(`
      (() => {
        const err = document.getElementById('app-error');
        const loading = document.getElementById('app-loading');
        const root = document.getElementById('root');
        const txt = (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 400);
        return {
          title: document.title,
          errorPageShown: !!err && getComputedStyle(err).display !== 'none',
          loadingStillShown: !!loading && !!loading.offsetParent,
          rootChildCount: root ? root.children.length : -1,
          rootFirstTag: root && root.firstElementChild ? root.firstElementChild.tagName : null,
          totalElements: document.querySelectorAll('*').length,
          buttons: document.querySelectorAll('button').length,
          textareas: document.querySelectorAll('textarea').length,
          visibleTextSample: txt,
          topBarButtons: [...document.querySelectorAll("button")].map(e=>{const r=e.getBoundingClientRect();return {top:Math.round(r.top),h:Math.round(r.height),left:Math.round(r.left)};}).filter(r=>r.left<420&&r.top<90&&r.h>=18&&r.h<=44).sort((a,b)=>a.left-b.left),
        };
      })()
    `);
  } catch (err) {
    dom = { domError: String(err) };
  }

  try {
    const img = await win.webContents.capturePage();
    fs.mkdirSync(path.dirname(OUT_PNG), { recursive: true });
    fs.writeFileSync(OUT_PNG, img.toPNG());
  } catch (err) {
    consoleLines.push('CAPTURE-ERROR ' + String(err));
  }

  const errorConsole = consoleLines.filter((l) => /error|gone|Uncaught|TypeError|Failed|refused/i.test(l));
  const report = {
    dom,
    sidecarStatus: supervisor ? supervisor.getStatus() : 'no-bundle',
    sidecarPid: supervisor ? supervisor.getSidecarPid() : null,
    consoleErrorCount: errorConsole.length,
    consoleErrorSample: [...new Set(errorConsole)].slice(0, 30),
    consoleLineCount: consoleLines.length,
  };
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
  console.log('[dev-smoke] done →', OUT_PNG, JSON.stringify(report.dom));

  if (supervisor) await supervisor.stop();
  app.exit(0);
});
