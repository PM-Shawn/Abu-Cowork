/**
 * Boot-verify harness — acceptance check for Phase 2 slice A ("startup
 * foundation") + slice B ("event bridge") + slice C ("secret store"). Same
 * shape as electron/spike/bootSpike.cjs, but exercises the PRODUCTION
 * preload (electron/preload.cjs) + registerTauriHost(app) instead of the
 * throwaway capture shim, to prove the real frontend now boots past the
 * path-plugin/platform-detection cascade.
 *
 * Loads dist-electron-spike/index.html windowless (show:false), lets it
 * settle, then asserts NONE of the five known boot-cascade error substrings
 * (from the pre-slice-A boot spike) still appear in captured renderer
 * console output. Then (slice B) drives a real event round-trip: registers a
 * `listen()`-shaped callback via `transformCallback` + `plugin:event|listen`
 * in the page world, has main call `emitEvent()`, and asserts the callback
 * received the Tauri Event object — proving the callback survives the
 * contextBridge boundary and main→renderer delivery works. Then (slice C)
 * drives a real secret_set/get/has/list/delete round-trip through
 * window.__TAURI_INTERNALS__.invoke, asserting a non-ASCII value round-trips
 * exactly. That round-trip is wrapped in a timeout because safeStorage can
 * trigger an OS Keychain access prompt on first use on macOS, which would
 * block this unattended run — see the secretRoundTrip block below. Writes
 * electron-results/boot-verify.json with
 * {pass, remainingErrors, stubCommands, eventRoundTrip, secretRoundTrip,
 * secretNote?}. PASS requires no cascade errors AND eventRoundTrip AND
 * secretRoundTrip. Run:
 *   npm run electron:boot-verify
 */
'use strict';

const { app, BrowserWindow, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { registerTauriHost, getStubbedCommands, emitEvent } = require('../tauriHost.cjs');

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

  // Phase 2 slice B acceptance: prove the callback registered via
  // transformCallback survives the contextBridge boundary and that main
  // (emitEvent) can deliver an event back to it through the real
  // plugin:event|listen subscription registry — not just that the invoke
  // resolves.
  let eventRoundTrip = false;
  try {
    await win.webContents.executeJavaScript(`
      (async () => {
        globalThis.__abuEvtTest = null;
        const id = window.__TAURI_INTERNALS__.transformCallback((e) => { globalThis.__abuEvtTest = e; });
        await window.__TAURI_INTERNALS__.invoke('plugin:event|listen', { event: 'abu-b-roundtrip', target: { kind: 'Any' }, handler: id });
        return true;
      })()
    `);
    emitEvent('abu-b-roundtrip', { hello: 'B' });
    await new Promise((r) => setTimeout(r, 300));
    const result = await win.webContents.executeJavaScript('globalThis.__abuEvtTest');
    eventRoundTrip = !!result && result.event === 'abu-b-roundtrip' && typeof result.id === 'number' && result.payload && result.payload.hello === 'B';
    if (!eventRoundTrip) {
      consoleLines.push('EVENT-ROUNDTRIP-MISMATCH ' + JSON.stringify(result));
    }
  } catch (err) {
    consoleLines.push('EVENT-ROUNDTRIP-ERROR ' + String(err));
  }

  // Phase 2 slice C acceptance: real secret_set/get/has/list/delete round-trip
  // through the production IPC surface, asserting a non-ASCII value survives
  // exactly. RISK: safeStorage can trigger an OS Keychain access prompt on
  // first use on macOS, which would block this unattended run — so the
  // round-trip is raced against a timeout, and an unavailable/timed-out
  // safeStorage is recorded as a clear note rather than treated as a silent
  // crash (the harness still finishes and reports the other checks).
  let secretRoundTrip = false;
  let secretNote;
  const SECRET_TIMEOUT_MS = 6000;
  try {
    let encryptionAvailable = false;
    try {
      encryptionAvailable = safeStorage.isEncryptionAvailable();
    } catch (err) {
      consoleLines.push('SECRET-ROUNDTRIP-AVAILABILITY-ERROR ' + String(err));
    }

    if (!encryptionAvailable) {
      secretNote = 'safeStorage unavailable / possible Keychain prompt — needs attended verification';
      consoleLines.push('SECRET-ROUNDTRIP-SKIPPED: safeStorage.isEncryptionAvailable() === false');
    } else {
      const attempt = win.webContents.executeJavaScript(`
        (async () => {
          const K = 'provider:__spikeC_test__';
          const inv = (c,a)=>window.__TAURI_INTERNALS__.invoke(c,a);
          await inv('secret_set', { key: K, value: 'sk-electron-C-秘密🔐' });
          const got = await inv('secret_get', { key: K });
          const has = await inv('secret_has', { key: K });
          const list = await inv('secret_list', {});
          await inv('secret_delete', { key: K });
          const afterDel = await inv('secret_get', { key: K });
          return { got, has, listHasK: Array.isArray(list) && list.includes(K), afterDel };
        })()
      `);
      const timeout = new Promise((resolve) =>
        setTimeout(() => resolve({ __timedOut: true }), SECRET_TIMEOUT_MS)
      );
      const result = await Promise.race([attempt, timeout]);

      if (result && result.__timedOut) {
        secretNote = 'safeStorage unavailable / possible Keychain prompt — needs attended verification';
        consoleLines.push(`SECRET-ROUNDTRIP-TIMEOUT after ${SECRET_TIMEOUT_MS}ms`);
      } else {
        secretRoundTrip =
          !!result &&
          result.got === 'sk-electron-C-秘密🔐' &&
          result.has === true &&
          result.listHasK === true &&
          result.afterDel === null;
        if (!secretRoundTrip) {
          consoleLines.push('SECRET-ROUNDTRIP-MISMATCH ' + JSON.stringify(result));
        }
      }
    }
  } catch (err) {
    secretNote = 'safeStorage unavailable / possible Keychain prompt — needs attended verification';
    consoleLines.push('SECRET-ROUNDTRIP-ERROR ' + String(err));
  }

  const errorLines = consoleLines.filter((l) => /error|gone|LOAD-ERROR|Uncaught|TypeError/i.test(l));
  const remainingErrors = [...new Set(errorLines)];
  const goneOk = MUST_BE_GONE.every((needle) => !remainingErrors.some((l) => l.includes(needle)));
  const pass = goneOk && eventRoundTrip && secretRoundTrip;

  const stubCommands = getStubbedCommands();

  const report = {
    pass,
    remainingErrors,
    stubCommands,
    eventRoundTrip,
    secretRoundTrip,
    ...(secretNote ? { secretNote } : {}),
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

  console.log(
    `[boot-verify] ${pass ? 'PASS' : 'FAIL'} — ${remainingErrors.length} remaining console error line(s), eventRoundTrip=${eventRoundTrip}, secretRoundTrip=${secretRoundTrip} → ${OUT}`
  );
  if (secretNote) {
    console.log(`  ⚠ secretNote: ${secretNote}`);
  }
  if (remainingErrors.length) {
    for (const l of remainingErrors) console.log('  •', l);
  }

  app.exit(pass ? 0 : 1);
});
