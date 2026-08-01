/**
 * Frontend-boot spike — main process. THROWAWAY recon tooling (Phase 2).
 *
 * Loads the real Abu frontend (built with a relative base into
 * dist-electron-spike/) behind the Tauri IPC capture shim, lets it settle,
 * then writes electron-results/boot-spike.json: the ordered list of every
 * invoke(cmd,args) the frontend fired at boot (commands + event subscriptions),
 * plus renderer console errors so we can see how far it got. Windowless-ish
 * (show:false) so it doesn't pop on the user's screen. Run:
 *   npx electron electron/spike/bootSpike.cjs
 */
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const SETTLE_MS = 9000;
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INDEX = path.join(REPO_ROOT, 'dist-electron-spike', 'index.html');
const OUT = path.join(REPO_ROOT, 'electron-results', 'boot-spike.json');

const calls = [];
ipcMain.on('spike:invoke', (_e, rec) => calls.push(rec));

app.on('window-all-closed', () => app.quit());

app.whenReady().then(async () => {
  if (!fs.existsSync(INDEX)) {
    console.error('[boot-spike] missing build:', INDEX, '\nRun: npx vite build --base=./ --outDir dist-electron-spike');
    app.exit(2);
    return;
  }

  const consoleLines = [];
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'tauriShimPreload.cjs'),
      contextIsolation: false,
      sandbox: false,
      nodeIntegration: false,
    },
  });

  // console-message signature varies across Electron majors — capture loosely.
  win.webContents.on('console-message', (...a) => {
    const parts = a.slice(1).map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x)));
    consoleLines.push(parts.join(' '));
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    consoleLines.push('RENDER-GONE ' + JSON.stringify(d));
  });

  try {
    await win.loadFile(INDEX);
  } catch (err) {
    consoleLines.push('LOAD-ERROR ' + String(err));
  }

  await new Promise((r) => setTimeout(r, SETTLE_MS));

  // Ordered unique commands (first-seen order) + per-command counts.
  const order = [];
  const counts = {};
  const events = [];
  for (const c of calls) {
    counts[c.cmd] = (counts[c.cmd] || 0) + 1;
    if (!order.includes(c.cmd)) order.push(c.cmd);
    if (c.cmd === 'plugin:event|listen' && c.args && c.args.event) events.push(c.args.event);
  }

  const report = {
    settleMs: SETTLE_MS,
    totalCalls: calls.length,
    uniqueCommands: order.length,
    commandOrder: order,
    commandCounts: counts,
    eventSubscriptions: [...new Set(events)],
    firstCalls: calls.slice(0, 60),
    consoleErrorSample: consoleLines.filter((l) => /error|gone|LOAD-ERROR|Uncaught|TypeError/i.test(l)).slice(0, 40),
    consoleLineCount: consoleLines.length,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`[boot-spike] ${calls.length} invoke calls, ${order.length} unique commands, ${report.eventSubscriptions.length} event subs → ${OUT}`);
  app.exit(0);
});
