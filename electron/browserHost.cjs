/**
 * Electron main-side "in-app browser" host — port of
 * `src-tauri/src/browser.rs`'s 9 `browser_*` commands, backing the workspace
 * browser tab (`src/components/panel/workspace/BrowserTab.tsx`).
 *
 * Tauri's version paints a real native CHILD WEBVIEW (`window.add_child`)
 * over the React UI at pixel coordinates. Electron's equivalent primitive is
 * `WebContentsView` attached to the main window's root `contentView` via
 * `addChildView()` + `setBounds()` — same "layer painted over the page,
 * ignores CSS" model, so BrowserTab.tsx's existing bounds-sync /
 * hide-when-covered logic ports over unchanged (it only ever talks to these
 * 9 commands + the `browser://nav/{id}` event, never to the native layer
 * directly).
 *
 * ## Security — untrusted web content
 * This view loads ARBITRARY sites the user types into the address bar
 * (Google, GitHub, banks, …), i.e. fully untrusted web content. Its
 * `webContents` therefore gets `sandbox: true` + `contextIsolation: true` +
 * `nodeIntegration: false` + **no `preload`** — no privileged API surface is
 * exposed to loaded pages, matching Tauri's default webview isolation (the
 * Rust side never grants this webview any `invoke` capability either).
 *
 * ## Command → API mapping (verified against browser.rs + BrowserTab.tsx)
 * - `browser_create {id,url,x,y,width,height}` → new WebContentsView,
 *   `mainWin.contentView.addChildView(view)`, `setBounds`, `loadURL`.
 *   Re-invoking with an id that already has a view reuses it (navigate +
 *   reposition) — mirrors browser.rs's StrictMode-double-mount tolerance.
 * - `browser_set_bounds {id,x,y,width,height}` → `view.setBounds(...)`;
 *   errors "browser webview not found" if `id` is unknown (matches Rust).
 * - `browser_navigate {id,url}` → `view.webContents.loadURL(url)`; same
 *   not-found error as set_bounds.
 * - `browser_back/forward/reload {id}` → Rust drives these via
 *   `wv.eval("history.back()/.forward()/location.reload()")` (in-page JS,
 *   not the native session-history API); this port uses the native
 *   `webContents.navigationHistory.goBack()/goForward()` +
 *   `webContents.reload()` instead (per task brief) — behaviorally
 *   equivalent for ordinary top-level navigations, and errors
 *   "not found" if `id` is unknown (matches Rust's `ok_or_else(|| "not
 *   found")` — note the shorter message than set_bounds/navigate, which is
 *   an existing asymmetry in browser.rs, not a divergence introduced here).
 * - `browser_hide/show {id}` → `view.setVisible(false/true)`; silently
 *   no-ops if `id` is unknown (matches Rust's `if let Some(wv) = ...`).
 * - `browser_close {id}` → `mainWin.contentView.removeChildView(view)` +
 *   `view.webContents.close()` + delete from the id→view map; also silently
 *   no-ops if unknown.
 *
 * ## Navigation event: `browser://nav/{id}`
 * browser.rs's `on_navigation(move |u| { emit(...); true })` fires on every
 * navigation Tauri proposes to the webview (full loads AND same-document/SPA
 * navigations), always returning `true` (never blocks). Electron's nearest
 * pair is `did-navigate` (top-level loads) + `did-navigate-in-page` (SPA
 * pushState/hash navigations) — both are wired to emit the same event, for
 * parity with the Rust single-callback's broader coverage. Payload is the
 * navigated-to URL as a plain string (matches `listen<string>` in
 * BrowserTab.tsx:126).
 *
 * ## window.open / target="_blank"
 * browser.rs injects `NEW_WINDOW_SHIM` (an `initialization_script` that
 * redirects `window.open()`/blank-target link clicks into the SAME webview,
 * since a native child webview has no default popup handler). Electron's
 * `setWindowOpenHandler` achieves the same end (deny the popup, load the URL
 * in this view instead) without needing an injected script.
 *
 * Wired from electron/tauriHost.cjs via browserDispatch(app, cmd, args) —
 * see the wiring comment there for the dispatch-order slot (after
 * ptyDispatch). `app` is accepted for signature parity with the other
 * `*Dispatch(app, cmd, args)` families but unused (this module reaches the
 * main window via tauriHost's `getMainWindow()`, not via `app`).
 */
'use strict';

const { WebContentsView } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Lazy-required (not at top-level) to avoid a circular-require footgun:
// tauriHost.cjs requires THIS module (to wire browserDispatch into its
// command switch), and this module needs tauriHost's emitEvent/
// getMainWindow — same lazy pattern as ptyHost.cjs's `_emitEvent`.
let _tauriHost = null;
function tauriHost() {
  if (!_tauriHost) _tauriHost = require('./tauriHost.cjs');
  return _tauriHost;
}

function emit(event, payload) {
  tauriHost().emitEvent(event, payload);
}

function mainWindow() {
  return tauriHost().getMainWindow();
}

const BROWSER_CMDS = new Set([
  'browser_create',
  'browser_set_bounds',
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
  'browser_hide',
  'browser_show',
  'browser_close',
  'browser_inspect_set',
]);
const BROWSER_MISS = Symbol('browser-dispatch-miss');

const INSPECT_WORLD_ID = 1001;
const INSPECT_POLL_MS = 150;
const MAX_INSPECT_PAYLOAD_BYTES = 128 * 1024;
const INSPECT_RUNTIME_PATH = path.join(__dirname, 'browserInspectRuntime.js');
let inspectRuntime = null;
try {
  inspectRuntime = fs.readFileSync(INSPECT_RUNTIME_PATH, 'utf8');
} catch (err) {
  console.warn(
    `[browserHost] inspect runtime not found at ${INSPECT_RUNTIME_PATH}; browser element selection is unavailable:`,
    err instanceof Error ? err.message : String(err)
  );
}

/** id -> WebContentsView, mirroring browser.rs's label->webview lookup. */
const views = new Map();

/** id -> current inspect session. A session is invalidated on navigation/close. */
const inspectSessions = new Map();

function isInspectPayload(value) {
  if (!value || typeof value !== 'object' || typeof value.outerHTML !== 'string') return false;
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_INSPECT_PAYLOAD_BYTES;
  } catch {
    return false;
  }
}

function inspectApiCode(method, args) {
  return `(() => {
    const api = window.__ABU_BROWSER_INSPECT__;
    if (!api || typeof api[${JSON.stringify(method)}] !== 'function') {
      throw new Error('browser inspect runtime unavailable');
    }
    return api[${JSON.stringify(method)}](...${JSON.stringify(args)});
  })()`;
}

function runInspectCode(view, code) {
  if (!view || view.webContents.isDestroyed()) {
    return Promise.reject(new Error('browser webview not found'));
  }
  return view.webContents.executeJavaScriptInIsolatedWorld(INSPECT_WORLD_ID, [{ code }]);
}

function disarmInspect(id, updateRuntime) {
  const session = inspectSessions.get(id);
  if (!session) return;
  inspectSessions.delete(id);
  if (session.timer) clearTimeout(session.timer);
  if (updateRuntime) {
    void runInspectCode(session.view, inspectApiCode('setEnabled', [false, null, {}])).catch(() => {});
  }
}

function scheduleInspectPoll(id, session) {
  session.timer = setTimeout(async () => {
    if (inspectSessions.get(id) !== session) return;
    try {
      const entries = await runInspectCode(session.view, inspectApiCode('drainSelections', []));
      if (inspectSessions.get(id) !== session) return;
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          if (!entry || entry.nonce !== session.nonce || !isInspectPayload(entry.payload)) continue;
          emit(`browser://element/${id}`, entry.payload);
          // BrowserTab is single-select. Stop before emitting again so a burst
          // cannot turn one user interaction into multiple chat references.
          disarmInspect(id, true);
          return;
        }
      }
      scheduleInspectPoll(id, session);
    } catch {
      // A navigation/destroy can race the next timer. The next explicit toggle
      // installs a fresh runtime, so stale sessions must simply disappear.
      disarmInspect(id, false);
    }
  }, INSPECT_POLL_MS);
}

async function browserInspectSet({ id, enabled, labels }) {
  const view = getView(id);
  if (!view) throw new Error('browser webview not found');

  disarmInspect(id, true);
  if (!enabled) return null;
  if (!inspectRuntime) throw new Error('browser inspect runtime is unavailable');

  const nonce = crypto.randomBytes(32).toString('hex');
  await runInspectCode(view, inspectRuntime);
  await runInspectCode(view, inspectApiCode('setEnabled', [true, nonce, labels && typeof labels === 'object' ? labels : {}]));

  const session = { view, nonce, timer: null };
  inspectSessions.set(id, session);
  scheduleInspectPoll(id, session);
  return null;
}

/**
 * Validate-only URL parse — parity with browser.rs's `parse_url`, which
 * calls `url.parse::<tauri::Url>()` and just propagates the parse error; it
 * does NOT add a scheme for schemeless input (BrowserTab.tsx already runs
 * every address through `normalizeBrowserUrl()` before invoking, which adds
 * `https://`/`http://` client-side) — so this must not "help" either, or a
 * schemeless string that Tauri would reject would silently succeed here.
 */
function parseUrl(url) {
  try {
     
    new URL(url);
    return url;
  } catch (err) {
    throw new Error(`invalid url '${url}': ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Electron's Rectangle wants integer logical pixels; Tauri's LogicalPosition/
 * LogicalSize are floats but browser.rs already floors degenerate sizes via
 * `.max(1.0)` — mirrored here, plus rounding (Electron throws on non-integer
 * bounds where Rust's float API doesn't).
 */
function toRect(x, y, width, height) {
  return {
    x: Math.round(Number(x) || 0),
    y: Math.round(Number(y) || 0),
    width: Math.round(Math.max(Number(width) || 0, 1)),
    height: Math.round(Math.max(Number(height) || 0, 1)),
  };
}

function getView(id) {
  return views.get(id);
}

function browserCreate({ id, url, x, y, width, height }) {
  const win = mainWindow();
  if (!win || win.isDestroyed()) {
    throw new Error('main window not found');
  }

  const existing = views.get(id);
  if (existing) {
    // Already created (e.g. StrictMode double-mount) — reuse it, matching
    // browser.rs's early-return-and-reuse branch.
    if (url) {
      void existing.webContents.loadURL(parseUrl(url));
    }
    existing.setBounds(toRect(x, y, width, height));
    return null;
  }

  const view = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // No `preload` — this webContents loads arbitrary untrusted sites and
      // must get zero privileged API surface (see module header).
    },
  });

  // window.open()/target="_blank" ports of browser.rs's NEW_WINDOW_SHIM:
  // redirect into this same view instead of opening a new native window.
  view.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (targetUrl) void view.webContents.loadURL(targetUrl);
    return { action: 'deny' };
  });

  const onNav = (_e, navUrl) => {
    disarmInspect(id, false);
    emit(`browser://nav/${id}`, navUrl);
  };
  view.webContents.on('did-navigate', onNav);
  view.webContents.on('did-navigate-in-page', onNav);

  win.contentView.addChildView(view);
  view.setBounds(toRect(x, y, width, height));
  views.set(id, view);

  const target = url || 'about:blank';
  void view.webContents.loadURL(parseUrl(target));
  return null;
}

function browserSetBounds({ id, x, y, width, height }) {
  const view = getView(id);
  if (!view) throw new Error('browser webview not found');
  view.setBounds(toRect(x, y, width, height));
  return null;
}

function browserNavigate({ id, url }) {
  const view = getView(id);
  if (!view) throw new Error('browser webview not found');
  // Fire-and-forget, like browser.rs's `wv.navigate()` (doesn't wait for the
  // page to finish loading) — awaiting `loadURL()`'s promise here would
  // surface as an invoke() rejection on ordinary redirects (Chromium resolves
  // loadURL with ERR_ABORTED when a redirect/download interrupts the initial
  // navigation), which is not an error condition worth failing the command on.
  void parseUrl(url); // validate eagerly so a malformed URL still throws synchronously
  view.webContents.loadURL(url).catch(() => {});
  return null;
}

function browserBack({ id }) {
  const view = getView(id);
  if (!view) throw new Error('not found');
  // `webContents.goBack()` is deprecated in Electron 43+ in favor of the
  // `navigationHistory` object — same underlying session-history navigation.
  view.webContents.navigationHistory.goBack();
  return null;
}

function browserForward({ id }) {
  const view = getView(id);
  if (!view) throw new Error('not found');
  view.webContents.navigationHistory.goForward();
  return null;
}

function browserReload({ id }) {
  const view = getView(id);
  if (!view) throw new Error('not found');
  view.webContents.reload();
  return null;
}

function browserHide({ id }) {
  const view = getView(id);
  if (view) view.setVisible(false);
  return null;
}

function browserShow({ id }) {
  const view = getView(id);
  if (view) view.setVisible(true);
  return null;
}

function closeView(id, view) {
  disarmInspect(id, false);
  try {
    const win = mainWindow();
    if (win && !win.isDestroyed()) {
      win.contentView.removeChildView(view);
    }
  } catch {
    /* window may already be torn down (app quitting) — best-effort */
  }
  try {
    if (!view.webContents.isDestroyed()) {
      view.webContents.close();
    }
  } catch {
    /* already gone — best-effort */
  }
  views.delete(id);
}

function browserClose({ id }) {
  const view = getView(id);
  if (view) closeView(id, view);
  return null;
}

/**
 * @param {import('electron').App} app unused — kept for signature parity
 *   with the other *Dispatch(app, cmd, args) families (e.g. ptyDispatch).
 * @param {string} cmd
 * @param {Record<string, unknown>} args
 * @returns command result, or BROWSER_MISS if `cmd` isn't one of the
 *   browser family.
 */
function browserDispatch(app, cmd, args) {
  void app;
  if (!BROWSER_CMDS.has(cmd)) return BROWSER_MISS;
  const a = args || {};
  switch (cmd) {
    case 'browser_create':
      return browserCreate(a);
    case 'browser_set_bounds':
      return browserSetBounds(a);
    case 'browser_navigate':
      return browserNavigate(a);
    case 'browser_back':
      return browserBack(a);
    case 'browser_forward':
      return browserForward(a);
    case 'browser_reload':
      return browserReload(a);
    case 'browser_hide':
      return browserHide(a);
    case 'browser_show':
      return browserShow(a);
    case 'browser_close':
      return browserClose(a);
    case 'browser_inspect_set':
      return browserInspectSet(a);
    default:
      return BROWSER_MISS;
  }
}

/** No orphans: tear down every live browser view on app quit. */
function closeAllBrowserViews() {
  for (const [id, view] of views) {
    closeView(id, view);
  }
}

module.exports = { browserDispatch, BROWSER_MISS, closeAllBrowserViews };
