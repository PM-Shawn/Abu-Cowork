/**
 * F7 "in-app browser" headless verification — boots a real (hidden)
 * Electron window with the PRODUCTION preload + registerTauriHost +
 * wireWindowEvents(win) (so browserHost.cjs's `getMainWindow()` resolves a
 * real window, exactly as it will in electron/main.cjs), then from the
 * RENDERER drives browser_create/set_bounds/navigate/hide/show/back/close
 * via `window.__TAURI_INTERNALS__.invoke` (the exact path BrowserTab.tsx
 * uses), registering a REAL `browser://nav/{id}` listener the same way
 * `@tauri-apps/api/event`'s `listen()` does under the hood
 * (`transformCallback` + `plugin:event|listen`) — modeled on
 * electron/spike/f6Verify.cjs.
 *
 * Uses two local `file://` tmp HTML pages (no network dependency) to drive
 * real navigations through a WebContentsView.
 *
 * Checks:
 *  1. browser_create with page1 (file://) resolves without throwing, and a
 *     `browser://nav/{id}` event delivers page1's URL (did-navigate).
 *  2. browser_navigate to page2 -> a second browser://nav event delivers
 *     page2's URL.
 *  3. browser_set_bounds doesn't throw.
 *  4. browser_hide / browser_show don't throw.
 *  5. browser_back doesn't throw (history: page1 -> page2, so back is valid).
 *  6. browser_close doesn't throw, and the view is actually removed (no
 *     longer tracked — a second browser_close is a no-op, matching
 *     browser.rs's `if let Some(wv) = ...` semantics).
 *
 * Run: npx electron electron/spike/f7Verify.cjs   (self-exits, prints JSON)
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { registerTauriHost, wireWindowEvents } = require('../tauriHost.cjs');

app.on('window-all-closed', () => app.quit());

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** @type {{name: string, pass: boolean, detail?: unknown}[]} */
const checks = [];
function record(name, pass, detail) {
  checks.push({ name, pass, detail });
}

app.whenReady().then(async () => {
  registerTauriHost(app);

  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // Wire the SAME window-lifecycle bridge main.cjs uses in production, so
  // getMainWindow() (browserHost.cjs's route to the main window) resolves a
  // real window exactly as it will at runtime.
  wireWindowEvents(win);

  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  const invokeIn = async (cmd, args) =>
    win.webContents.executeJavaScript(
      `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? null)})`
    );

  /**
   * Register a real `listen(event, cb)`-shaped subscription in the page
   * world (transformCallback + plugin:event|listen), stashing every
   * delivered payload onto a page-global array so this main-side script can
   * poll it.
   */
  async function listenIn(event, stashKey) {
    await win.webContents.executeJavaScript(`
      (async () => {
        globalThis[${JSON.stringify(stashKey)}] = [];
        const id = window.__TAURI_INTERNALS__.transformCallback((e) => {
          globalThis[${JSON.stringify(stashKey)}].push(e.payload);
        });
        await window.__TAURI_INTERNALS__.invoke('plugin:event|listen', {
          event: ${JSON.stringify(event)},
          target: { kind: 'Any' },
          handler: id,
        });
        return true;
      })()
    `);
  }

  const readStash = async (stashKey) => win.webContents.executeJavaScript(`globalThis[${JSON.stringify(stashKey)}]`);

  async function waitForStashNonEmpty(stashKey, deadlineMs) {
    const deadline = Date.now() + deadlineMs;
    let values = [];
    while (Date.now() < deadline) {
      values = await readStash(stashKey);
      if (Array.isArray(values) && values.length > 0) return values;
      await wait(150);
    }
    return values;
  }

  // ── fixtures: two local file:// pages ──
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-f7-verify-'));
  const page1Path = path.join(tmpDir, 'page1.html');
  const page2Path = path.join(tmpDir, 'page2.html');
  fs.writeFileSync(page1Path, '<!doctype html><html><body><h1>abu-f7-page1</h1></body></html>');
  fs.writeFileSync(page2Path, '<!doctype html><html><body><h1>abu-f7-page2</h1></body></html>');
  const page1Url = pathToFileURL(page1Path).href;
  const page2Url = pathToFileURL(page2Path).href;

  const tabId = `f7-verify-${Date.now()}`;
  const navStashKey = 'abuF7Nav';

  // Register the nav listener BEFORE browser_create, matching BrowserTab.tsx's
  // real ordering (listen() is awaited in the mount effect before
  // ensureWebview() creates the native view).
  await listenIn(`browser://nav/${tabId}`, navStashKey);

  // ── 1. browser_create (file://page1) + nav event ──
  try {
    await invokeIn('browser_create', {
      id: tabId,
      url: page1Url,
      x: 10,
      y: 10,
      width: 400,
      height: 300,
    });
    record('browser_create_no_throw', true);
  } catch (err) {
    record('browser_create_no_throw', false, String(err));
  }

  {
    const navs = await waitForStashNonEmpty(navStashKey, 8000);
    record('nav_event_on_create_page1', navs.includes(page1Url), { navs, expected: page1Url });
  }

  // ── 2. browser_navigate (file://page2) + second nav event ──
  try {
    await invokeIn('browser_navigate', { id: tabId, url: page2Url });
    record('browser_navigate_no_throw', true);
  } catch (err) {
    record('browser_navigate_no_throw', false, String(err));
  }

  {
    const deadline = Date.now() + 8000;
    let navs = await readStash(navStashKey);
    while (Date.now() < deadline && !navs.includes(page2Url)) {
      await wait(150);
      navs = await readStash(navStashKey);
    }
    record('nav_event_on_navigate_page2', navs.includes(page2Url), { navs, expected: page2Url });
  }

  // ── 3. browser_set_bounds (no throw) ──
  try {
    await invokeIn('browser_set_bounds', { id: tabId, x: 20, y: 20, width: 500, height: 400 });
    record('browser_set_bounds_no_throw', true);
  } catch (err) {
    record('browser_set_bounds_no_throw', false, String(err));
  }

  // ── 4. browser_hide / browser_show (no throw) ──
  try {
    await invokeIn('browser_hide', { id: tabId });
    await invokeIn('browser_show', { id: tabId });
    record('browser_hide_show_no_throw', true);
  } catch (err) {
    record('browser_hide_show_no_throw', false, String(err));
  }

  // ── 5. browser_back (no throw; history has page1 -> page2) ──
  try {
    await invokeIn('browser_back', { id: tabId });
    record('browser_back_no_throw', true);
  } catch (err) {
    record('browser_back_no_throw', false, String(err));
  }

  // ── 6. browser_close -> view removed (idempotent second close) ──
  try {
    await invokeIn('browser_close', { id: tabId });
    record('browser_close_no_throw', true);
  } catch (err) {
    record('browser_close_no_throw', false, String(err));
  }
  try {
    await invokeIn('browser_close', { id: tabId }); // closing again must not throw
    record('browser_close_idempotent_no_throw', true);
  } catch (err) {
    record('browser_close_idempotent_no_throw', false, String(err));
  }
  // A stale-id command post-close should error like browser.rs's
  // `ok_or_else` path (proves the map entry was actually deleted, not just
  // that close() itself didn't throw).
  try {
    await invokeIn('browser_navigate', { id: tabId, url: page1Url });
    record('post_close_navigate_rejects', false, 'expected navigate on closed id to throw');
  } catch (err) {
    record('post_close_navigate_rejects', /not found/i.test(String(err)), String(err));
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });

  const passed = checks.every((c) => c.pass);
  for (const c of checks) {
    console.log(`[f7-verify] ${c.pass ? 'PASS' : 'FAIL'} ${c.name}${c.detail !== undefined ? ' ' + JSON.stringify(c.detail) : ''}`);
  }
  console.log(`[f7-verify] PASSED=${passed}`);
  app.exit(passed ? 0 : 1);
});
