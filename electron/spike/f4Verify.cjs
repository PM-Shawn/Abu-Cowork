/**
 * F4 "fs watch" end-to-end verification — boots a real (hidden) Electron
 * window with the PRODUCTION preload + registerTauriHost, then from the
 * RENDERER drives `plugin:fs|watch`/`plugin:resources|close` the exact way
 * `@tauri-apps/plugin-fs`'s `watch()` does: `new Channel()` passed as
 * `onEvent`, `Watcher(rid).close()` to unwatch. Modeled on
 * electron/spike/f1aE2E.cjs / f2Verify.cjs.
 *
 * Exercises the REAL `@tauri-apps/api/core` `Channel` class (dynamic-imported
 * from node_modules inside the page) to prove out the full chain, including a
 * finding from empirical probing during implementation: Electron's
 * contextBridge does NOT preserve `Channel`'s `[SERIALIZE_TO_IPC_FN]` method
 * across the main-world -> preload-isolated-world call boundary (it's a
 * prototype method, and contextBridge only proxies OWN-enumerable function
 * properties) — only `Channel`'s own `id` property survives. preload.cjs's
 * `serializeChannels` handles this by recognizing a bare `{ id: <number> }`
 * shape and rebuilding `"__CHANNEL__:<id>"` itself. This harness runs the
 * REAL Channel class (not a hand-rolled stand-in) specifically so that
 * degradation path is what gets exercised, not bypassed.
 *
 * Checks:
 *  1. watch() a temp dir, write a new file into it from the MAIN side (real
 *     node fs, after the watch is registered) -> the renderer's Channel
 *     `onmessage` fires with an event whose `paths` includes the file and
 *     whose `type` is present (object form, e.g. `{ create: {} }`).
 *  2. plugin:resources|close (the real unwatch path — see fsWatchHost.cjs
 *     header for why it's not `plugin:fs|unwatch`) actually stops delivery:
 *     a write after close produces no new event.
 *
 * Run: npx electron electron/spike/f4Verify.cjs   (self-exits, prints JSON)
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { registerTauriHost } = require('../tauriHost.cjs');
const { registerPrivilegedWindow } = require('../securityBoundary.cjs');

app.on('window-all-closed', () => app.quit());

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
  // NOTE: NOT electron/renderer/index.html here — its CSP (`default-src
  // 'none'`) blocks dynamic import() (needed below to exercise the REAL
  // @tauri-apps/api Channel class, not a hand-rolled stand-in), and a
  // `data:` URL's opaque origin blocks it too (verified: both fail with
  // "Failed to fetch dynamically imported module"). A same-directory
  // `file://` page with no CSP does not have either problem (verified with a
  // throwaway probe), so use a disposable scratch html file instead.
  // preload.cjs (the thing actually under test) is unchanged; only the
  // hosting shell page differs from the other spikes.
  const scratchHtml = path.join(__dirname, '__f4verify-scratch.html');
  fs.writeFileSync(scratchHtml, '<!doctype html><title>f4-verify</title>');
  registerPrivilegedWindow(win, scratchHtml, { label: 'verify-f4' });
  await win.loadFile(scratchHtml);

  const invokeIn = async (cmd, args) =>
    win.webContents.executeJavaScript(
      `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? null)})`
    );

  const dir = fs.mkdtempSync(path.join(os.homedir(), '.f4-verify-'));
  const coreUrl = pathToFileURL(
    path.join(__dirname, '..', '..', 'node_modules', '@tauri-apps', 'api', 'core.js')
  ).href;

  // ── Set up: import the REAL Channel class in the renderer, watch `dir` ──
  let setup;
  try {
    setup = await win.webContents.executeJavaScript(`(async () => {
      window.__f4Events = [];
      const mod = await import(${JSON.stringify(coreUrl)});
      const channel = new mod.Channel((msg) => window.__f4Events.push(msg));
      window.__f4Channel = channel; // keep it alive (registered callback holds no other ref)
      const rid = await window.__TAURI_INTERNALS__.invoke('plugin:fs|watch', {
        paths: [${JSON.stringify(dir)}],
        options: { delayMs: 50, recursive: false },
        onEvent: channel,
      });
      window.__f4Rid = rid;
      return { rid, channelId: channel.id };
    })()`);
  } catch (err) {
    console.log('[f4-verify] setup threw: ' + String(err));
    console.log('[f4-verify] PASSED = false');
    fs.rmSync(scratchHtml, { force: true });
    app.exit(1);
    return;
  }

  // ── Drive a real fs change from the MAIN side, after the watch exists ──
  const target = path.join(dir, 'hello.txt');
  fs.writeFileSync(target, 'hi');

  // Debounce window is 50ms; give it generous headroom.
  await wait(700);
  const eventsAfterWrite = await win.webContents.executeJavaScript('window.__f4Events');

  // ── Unwatch via the REAL Resource.close() path: plugin:resources|close ──
  await invokeIn('plugin:resources|close', { rid: setup.rid });
  const countAtClose = eventsAfterWrite.length;
  fs.writeFileSync(path.join(dir, 'after-unwatch.txt'), 'should not be seen');
  await wait(400);
  const eventsAfterUnwatch = await win.webContents.executeJavaScript('window.__f4Events');

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(scratchHtml, { force: true });

  const hitTarget = eventsAfterWrite.some(
    (e) => e && Array.isArray(e.paths) && e.paths.some((p) => p === target)
  );
  const hasType = eventsAfterWrite.some((e) => e && e.type !== undefined && e.type !== null);
  const unwatchHeld = eventsAfterUnwatch.length === countAtClose;
  const ridIsNumber = typeof setup.rid === 'number';

  const checks = { ridIsNumber, hitTarget, hasType, unwatchHeld };
  const passed = Object.values(checks).every(Boolean);

  console.log('[f4-verify] setup = ' + JSON.stringify(setup));
  console.log('[f4-verify] eventsAfterWrite = ' + JSON.stringify(eventsAfterWrite));
  console.log('[f4-verify] eventsAfterUnwatch = ' + JSON.stringify(eventsAfterUnwatch));
  console.log('[f4-verify] checks = ' + JSON.stringify(checks));
  console.log('[f4-verify] PASSED = ' + passed);
  app.exit(passed ? 0 : 1);
});
