/**
 * Deep-link (`abu://enroll`) end-to-end verification — boots a real (hidden)
 * Electron window with the PRODUCTION preload + registerTauriHost + initDeepLink,
 * then drives the exact path a real deep link takes: an `open-url` event in the
 * MAIN process → normalize/queue/flush → delivery to a REAL renderer subscriber
 * registered via `@tauri-apps/plugin-deep-link`'s `onOpenUrl`. Modeled on
 * electron/spike/shellGlobalShortcutVerify.cjs (same hidden-window + dynamic
 * plugin-import pattern).
 *
 * Checks:
 *  1. Pure parser (used by all three arrival sources): normalizeDeepLinkUrl
 *     rewrites the dev scheme abu-dev://→abu://, passes canonical abu://,
 *     rejects unknown hosts and foreign schemes; extractDeepLinkFromArgv finds
 *     the URL in a commandLine array.
 *  2. FLUSH-ON-SUBSCRIBE race (the core design property): fire a running-app
 *     deep link BEFORE any renderer subscriber exists → it must be queued (not
 *     lost) → then register onOpenUrl → the queued URL is flushed and delivered,
 *     normalized to abu://.
 *  3. Subscriber-already-present: a second open-url is delivered immediately.
 *  4. Whitelist: a non-abu open-url (https://…) is ignored — never reaches the
 *     renderer.
 *  5. get_current wires to deepLinkHost (returns null with no cold-start URL in
 *     this harness — proven to reach the real handler, not the stub).
 *
 * NOT covered (documented, not silently skipped): a true COLD launch where the
 * OS fires open-url before app 'ready' cannot be simulated once the harness is
 * already past ready — check #1 exercises the argv/parser path that populates
 * cold-start instead. Real system-level protocol registration (clicking an
 * abu:// link in a browser) needs a signed .app bundle and is a packaging/real-
 * machine step.
 *
 * Run: npx electron electron/spike/deepLinkVerify.cjs
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { registerTauriHost, emitEvent, getMainWindow } = require('../tauriHost.cjs');
const deepLinkHost = require('../deepLinkHost.cjs');
const { initDeepLink, normalizeDeepLinkUrl, extractDeepLinkFromArgv } = deepLinkHost;

app.on('window-all-closed', () => app.quit());

// Track "[tauriHost] stub: <cmd>" lines so we can assert get_current reaches the
// real handler, not the catch-all stub.
const stubbedCmdsSeen = new Set();
const originalLog = console.log;
console.log = (...cargs) => {
  const line = cargs.map(String).join(' ');
  const m = /^\[tauriHost\] stub: (.+)$/.exec(line);
  if (m) stubbedCmdsSeen.add(m[1]);
  originalLog(...cargs);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  registerTauriHost(app);
  initDeepLink(app, { emitEvent, getMainWindow });

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  const scratchHtml = path.join(__dirname, '__deepLinkVerify-scratch.html');
  fs.writeFileSync(scratchHtml, '<!doctype html><title>deep-link-verify</title>');
  await win.loadFile(scratchHtml);

  const checks = {};
  const errors = {};

  // Helper: synchronously fire an open-url in the MAIN process, exactly as the
  // OS would when a running app is handed a deep link on macOS.
  const fireOpenUrl = (url) => app.emit('open-url', { preventDefault() {} }, url);
  const readReceived = () => win.webContents.executeJavaScript('window.__dlUrls || []');

  // ── 1) pure parser ──
  try {
    checks.normalizeRewritesDevScheme =
      normalizeDeepLinkUrl('abu-dev://enroll?server=https://ex.com&token=t') ===
      'abu://enroll?server=https://ex.com&token=t';
    checks.normalizePassesCanonical =
      normalizeDeepLinkUrl('abu://enroll?server=https://ex.com') ===
      'abu://enroll?server=https://ex.com';
    checks.normalizeRejectsUnknownHost = normalizeDeepLinkUrl('abu://wat?x=1') === null;
    checks.normalizeRejectsForeignScheme = normalizeDeepLinkUrl('https://evil.com') === null;
    checks.normalizeRejectsGarbage = normalizeDeepLinkUrl('not a url') === null;
    checks.extractFindsUrlInArgv =
      extractDeepLinkFromArgv(['electron', 'main.cjs', 'abu://enroll?server=x']) ===
      'abu://enroll?server=x';
    checks.extractNullWhenNone =
      extractDeepLinkFromArgv(['electron', 'main.cjs', '--flag']) === null;
  } catch (err) {
    errors.parser = String(err);
  }

  // ── 2) FLUSH-ON-SUBSCRIBE: fire BEFORE subscribing, must be queued not lost ──
  fireOpenUrl('abu-dev://enroll?server=https://queued.example.com&token=q1');
  await sleep(50);
  // No subscriber yet → nothing delivered. Now register the real onOpenUrl.
  // Register the subscriber exactly as @tauri-apps/plugin-deep-link's onOpenUrl
  // does — `listen('deep-link://new-url', e => handler(e.payload))`. We import
  // the built event.js by file URL (its imports are RELATIVE, so they resolve;
  // the plugin's own index.js uses bare '@tauri-apps/api/*' specifiers that a
  // renderer can't resolve, hence importing event.js directly).
  const eventJsUrl = pathToFileURL(
    path.join(__dirname, '..', '..', 'node_modules', '@tauri-apps', 'api', 'event.js')
  ).href;
  try {
    await win.webContents.executeJavaScript(`(async () => {
      window.__dlUrls = [];
      const mod = await import(${JSON.stringify(eventJsUrl)});
      // Mirror onOpenUrl: payload is the string[] of URLs.
      window.__dlUnlisten = await mod.listen('deep-link://new-url', (e) => {
        window.__dlUrls.push(...e.payload);
      });
      return true;
    })()`);
    checks.subscribeDidNotThrow = true;
  } catch (err) {
    checks.subscribeDidNotThrow = false;
    errors.subscribe = String(err);
  }
  await sleep(80); // let the flushed callback IPC reach the renderer
  let received = await readReceived();
  checks.queuedUrlFlushedOnSubscribe =
    received.length === 1 &&
    received[0] === 'abu://enroll?server=https://queued.example.com&token=q1';

  // ── 3) subscriber present → immediate delivery ──
  fireOpenUrl('abu-dev://enroll?server=https://live.example.com&token=q2');
  await sleep(80);
  received = await readReceived();
  checks.liveUrlDeliveredImmediately =
    received.length === 2 && received[1] === 'abu://enroll?server=https://live.example.com&token=q2';

  // ── 4) whitelist: non-abu url ignored ──
  fireOpenUrl('https://evil.example.com/steal');
  await sleep(60);
  received = await readReceived();
  checks.foreignUrlIgnored = received.length === 2; // unchanged

  // ── 5) get_current reaches the real handler (null: no cold-start here) ──
  const cur = await win.webContents.executeJavaScript(
    `window.__TAURI_INTERNALS__.invoke('plugin:deep-link|get_current', null)`
  );
  checks.getCurrentNullNoColdStart = cur === null;
  checks.getCurrentReachedRealHandler = !stubbedCmdsSeen.has('plugin:deep-link|get_current');

  fs.rmSync(scratchHtml, { force: true });

  const passed = Object.values(checks).every(Boolean);
  originalLog('[deep-link-verify] checks = ' + JSON.stringify(checks, null, 2));
  originalLog('[deep-link-verify] errors = ' + JSON.stringify(errors, null, 2));
  originalLog('[deep-link-verify] PASSED = ' + passed);
  app.exit(passed ? 0 : 1);
});
