/**
 * `plugin:shell|open` + `plugin:global-shortcut|*` end-to-end verification —
 * boots a real (hidden) Electron window with the PRODUCTION preload +
 * registerTauriHost, then from the RENDERER drives both command families the
 * exact way their respective plugin JS does. Modeled on
 * electron/spike/f4Verify.cjs (same real-Channel-class + hidden-window
 * pattern, same `invokeIn` helper style).
 *
 * Checks:
 *  1. `plugin:shell|open` with a non-existent, non-URL path: reaches the REAL
 *     handler (proven by asserting `[tauriHost] stub: plugin:shell|open` is
 *     NEVER logged, via a console.log intercept) and correctly rejects
 *     (shell.openPath errors on a path that doesn't exist) rather than
 *     silently no-op'ing like the stub would. Deliberately does NOT invoke a
 *     real URL/existing path — this harness must not actually open a browser
 *     or Finder window as a side effect.
 *  2. A CONTROL case: invoking a genuinely unhandled command DOES produce the
 *     stub log — proves the intercept itself actually detects the stub path
 *     (so check #1's "stub NOT seen" is a meaningful negative, not a
 *     mechanism that's silently broken).
 *  3. `plugin:global-shortcut|register` (with a real `Channel` handler, same
 *     as @tauri-apps/plugin-global-shortcut's `register()`) on an accelerator
 *     unlikely to collide with anything real -> `is_registered` reports
 *     `true` -> `unregister` -> `is_registered` reports `false`. Also asserts
 *     neither `register` nor `is_registered` hit the stub log.
 *
 * NOT covered (documented, not silently skipped): actually firing the global
 * shortcut by a real keypress cannot be simulated headlessly (Electron's
 * globalShortcut is a real OS-level hotkey binding) — this harness only
 * proves register/is_registered/unregister wire correctly and reach the real
 * handler, not that a physical keypress delivers a ShortcutEvent to the
 * renderer's Channel callback.
 *
 * Run: npx electron electron/spike/shellGlobalShortcutVerify.cjs
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { registerTauriHost } = require('../tauriHost.cjs');

app.on('window-all-closed', () => app.quit());

// ── console.log intercept: track every "[tauriHost] stub: <cmd>" line seen ──
const stubbedCmdsSeen = new Set();
const originalLog = console.log;
console.log = (...cargs) => {
  const line = cargs.map(String).join(' ');
  const m = /^\[tauriHost\] stub: (.+)$/.exec(line);
  if (m) stubbedCmdsSeen.add(m[1]);
  originalLog(...cargs);
};

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
  // Same scratch-html-with-no-CSP approach as f4Verify.cjs, needed to
  // dynamic-import the REAL @tauri-apps/api Channel class for the
  // global-shortcut register() call.
  const scratchHtml = path.join(__dirname, '__shellGsVerify-scratch.html');
  fs.writeFileSync(scratchHtml, '<!doctype html><title>shell-gs-verify</title>');
  await win.loadFile(scratchHtml);

  const invokeIn = async (cmd, args) =>
    win.webContents.executeJavaScript(
      `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? null)})`
    );

  const checks = {};
  const errors = {};

  // ── 1) plugin:shell|open — non-existent, non-URL path ──
  const bogusPath = path.join(os.tmpdir(), `__abu-shell-verify-does-not-exist-${Date.now()}`);
  try {
    await invokeIn('plugin:shell|open', { path: bogusPath, with: null });
    checks.shellOpenRejected = false; // should NOT have resolved
  } catch (err) {
    checks.shellOpenRejected = true;
    errors.shellOpen = String(err);
  }
  checks.shellOpenReachedRealHandler = !stubbedCmdsSeen.has('plugin:shell|open');

  // ── 2) CONTROL: a genuinely unhandled command DOES hit the stub ──
  await invokeIn('plugin:__definitely_unhandled_control_cmd__', {});
  checks.controlStubDetected = stubbedCmdsSeen.has('plugin:__definitely_unhandled_control_cmd__');

  // ── 3) plugin:global-shortcut|register / is_registered / unregister ──
  const ACCEL = 'Control+Alt+Shift+F19'; // unlikely to collide with anything real
  const coreUrl = pathToFileURL(path.join(__dirname, '..', '..', 'node_modules', '@tauri-apps', 'api', 'core.js')).href;

  try {
    const regResult = await win.webContents.executeJavaScript(`(async () => {
      window.__gsEvents = [];
      const mod = await import(${JSON.stringify(coreUrl)});
      const channel = new mod.Channel((msg) => window.__gsEvents.push(msg));
      window.__gsChannel = channel; // keep alive
      await window.__TAURI_INTERNALS__.invoke('plugin:global-shortcut|register', {
        shortcuts: [${JSON.stringify(ACCEL)}],
        handler: channel,
      });
      return { channelId: channel.id };
    })()`);
    checks.registerDidNotThrow = true;
    checks.registerChannelIdIsNumber = typeof regResult.channelId === 'number';
  } catch (err) {
    checks.registerDidNotThrow = false;
    errors.register = String(err);
  }
  checks.registerReachedRealHandler = !stubbedCmdsSeen.has('plugin:global-shortcut|register');

  const isRegisteredAfterRegister = await invokeIn('plugin:global-shortcut|is_registered', { shortcut: ACCEL });
  checks.isRegisteredTrueAfterRegister = isRegisteredAfterRegister === true;
  checks.isRegisteredReachedRealHandler = !stubbedCmdsSeen.has('plugin:global-shortcut|is_registered');

  await invokeIn('plugin:global-shortcut|unregister', { shortcuts: [ACCEL] });
  const isRegisteredAfterUnregister = await invokeIn('plugin:global-shortcut|is_registered', { shortcut: ACCEL });
  checks.isRegisteredFalseAfterUnregister = isRegisteredAfterUnregister === false;

  fs.rmSync(scratchHtml, { force: true });

  const passed = Object.values(checks).every(Boolean);
  originalLog('[shell-gs-verify] checks = ' + JSON.stringify(checks, null, 2));
  originalLog('[shell-gs-verify] errors = ' + JSON.stringify(errors, null, 2));
  originalLog('[shell-gs-verify] stubbedCmdsSeen = ' + JSON.stringify([...stubbedCmdsSeen]));
  originalLog('[shell-gs-verify] PASSED = ' + passed);
  app.exit(passed ? 0 : 1);
});
