/**
 * Boot-verify harness — acceptance check for Phase 2 slice A ("startup
 * foundation"). Same shape as electron/spike/bootSpike.cjs, but exercises the
 * PRODUCTION preload (electron/preload.cjs) + registerTauriHost(app) instead
 * of the throwaway capture shim, to prove the real frontend now boots past
 * the path-plugin/platform-detection cascade.
 *
 * Loads dist-electron-spike/index.html windowless (show:false), lets it
 * settle, then asserts NONE of the five known boot-cascade error substrings
 * (from the pre-slice-A boot spike) still appear in captured renderer
 * console output. Writes electron-results/boot-verify.json with
 * {pass, remainingErrors, stubCommands}. Run:
 *   npm run electron:boot-verify
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { registerTauriHost, getStubbedCommands } = require('../tauriHost.cjs');

const SETTLE_MS = 9000;
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INDEX = path.join(REPO_ROOT, 'dist-electron-spike', 'index.html');
const OUT = path.join(REPO_ROOT, 'electron-results', 'boot-verify.json');
const PRELOAD = path.join(__dirname, '..', 'preload.cjs');

// Boot-cascade errors observed BEFORE slice A (see boot-spike.json) — these
// MUST be gone once the path plugin + platform detection are real.
const MUST_BE_GONE = [
  'Platform detection init error',
  '[RegistryWatcher] Failed to start',
  '[PluginLoader] Plugin discovery failed',
  'Discovery refresh failed',
  'Notice inbox drain error',
  '[Memdir] Migration failed',
];

app.on('window-all-closed', () => app.quit());

app.whenReady().then(async () => {
  if (!fs.existsSync(INDEX)) {
    console.error('[boot-verify] missing build:', INDEX, '\nRun: npx vite build --base=./ --outDir dist-electron-spike');
    app.exit(2);
    return;
  }

  registerTauriHost(app);

  const consoleLines = [];
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true, // must match production main.cjs so the verify exercises the real posture
      nodeIntegration: false,
    },
  });

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

  const errorLines = consoleLines.filter((l) => /error|gone|LOAD-ERROR|Uncaught|TypeError/i.test(l));
  const remainingErrors = [...new Set(errorLines)];
  const goneOk = MUST_BE_GONE.every((needle) => !remainingErrors.some((l) => l.includes(needle)));

  const stubCommands = getStubbedCommands();

  const report = { pass: goneOk, remainingErrors, stubCommands };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

  console.log(`[boot-verify] ${goneOk ? 'PASS' : 'FAIL'} — ${remainingErrors.length} remaining console error line(s) → ${OUT}`);
  if (remainingErrors.length) {
    for (const l of remainingErrors) console.log('  •', l);
  }

  app.exit(goneOk ? 0 : 1);
});
