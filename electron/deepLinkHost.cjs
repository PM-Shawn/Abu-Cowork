/**
 * Deep-link host — the Electron equivalent of tauri_plugin_deep_link.
 *
 * Abu's only deep link today is `abu://enroll?server=<url>&token=<token>`,
 * used to pre-fill the enterprise-binding form (an admin sends the user a link;
 * clicking it launches/focuses Abu with the server address filled in). The
 * frontend consumes it unchanged via `@tauri-apps/plugin-deep-link`:
 *   - getCurrent()  → invoke('plugin:deep-link|get_current')  → string[] | null
 *   - onOpenUrl(cb) → listen('deep-link://new-url')           → payload string[]
 *
 * Design is grounded in a firsthand teardown of five Electron competitors
 * (VS Code, Cursor, TRAE, ChatGPT/Codex, WorkBuddy) — see memory
 * `reference-electron-deeplink-across-competitors`. Their near-unanimous
 * conventions, adopted here:
 *   1. Register `open-url` EARLY (before app ready) — the OS can deliver a
 *      deep link before app code that handles it is set up.
 *   2. ONE parser (`normalizeDeepLinkUrl`) reused across all three arrival
 *      sources: macOS open-url, Win/Linux second-instance commandLine, and
 *      cold-start process.argv.
 *   3. Scheme + host + shape whitelist BEFORE forwarding anything to the
 *      renderer (don't relay arbitrary strings).
 *   4. Queue running-app URLs, then flush at a known-ready moment (when the
 *      renderer's `deep-link://new-url` subscriber appears) rather than
 *      blind-sending into a renderer that may not have mounted yet.
 *
 * Dev vs prod scheme: an installed production Abu (currently the Tauri build)
 * also owns `abu://`, so on a dev machine `open abu://…` could route to it
 * instead of this shell. To make dev verification deterministic we register a
 * separate `abu-dev://` scheme when unpackaged and rewrite it back to the
 * canonical `abu://` before the shared frontend parser (which only accepts
 * `abu:`) ever sees it. Packaged builds register the real `abu://`.
 */
'use strict';

const path = require('node:path');

const PROD_SCHEME = 'abu';
const DEV_SCHEME = 'abu-dev';
const NEW_URL_EVENT = 'deep-link://new-url';

// The single known deep-link action today. New actions must be added here so
// the whitelist keeps rejecting everything else.
const KNOWN_HOSTS = new Set(['enroll']);

let activeScheme = PROD_SCHEME;
let coldStartUrls = []; // URLs that cold-launched the app (get_current path)
let pendingHotUrls = []; // running-app URLs awaiting a renderer subscriber
let emitFn = null; // injected tauriHost.emitEvent (returns delivered count)
let getWindowFn = null; // injected tauriHost.getMainWindow

function log(msg, extra) {
  console.log(`[deepLink] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`);
}

/**
 * Normalize a raw URL string to the canonical `abu://…` form, or return null
 * if it is not one of our schemes / not a known action. This is the ONE parser
 * all three arrival sources funnel through (competitor convention #2/#3).
 * @param {unknown} raw
 * @returns {string | null}
 */
function normalizeDeepLinkUrl(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  // Windows may hand us "abu://…" or (rarely) "abu:…"; accept both forms.
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(s);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  if (scheme !== PROD_SCHEME && scheme !== DEV_SCHEME) return null;
  if (scheme === DEV_SCHEME) {
    // abu-dev://…  →  abu://…  (rewrite the dev scheme to the canonical one)
    s = PROD_SCHEME + s.slice(m[1].length);
  }
  try {
    const u = new URL(s);
    if (u.protocol !== 'abu:') return null;
    if (!KNOWN_HOSTS.has(u.hostname)) return null; // reject unknown actions
    return s;
  } catch {
    return null;
  }
}

/**
 * Find the first deep link in a process argv / commandLine array (Win/Linux
 * deliver the URL as a CLI argument).
 * @param {string[]} argv
 * @returns {string | null}
 */
function extractDeepLinkFromArgv(argv) {
  if (!Array.isArray(argv)) return null;
  for (const arg of argv) {
    const n = normalizeDeepLinkUrl(arg);
    if (n) return n;
  }
  return null;
}

/**
 * Wire deep-link handling. MUST be called before app 'ready' so the early
 * `open-url` listener is in place when the OS delivers a launching URL.
 * @param {import('electron').App} app
 * @param {{ emitEvent: (event: string, payload: unknown) => number, getMainWindow: () => import('electron').BrowserWindow | null }} deps
 */
function initDeepLink(app, deps) {
  emitFn = deps.emitEvent;
  getWindowFn = deps.getMainWindow;
  activeScheme = app.isPackaged ? PROD_SCHEME : DEV_SCHEME;

  // Register as the OS default handler for our scheme. In an unpackaged dev run
  // (`electron electron/main.cjs`) the registration must point back at the
  // electron binary + entry script so the OS can relaunch us with the URL
  // (required on Windows; harmless on macOS). Mirrors the Electron docs recipe.
  try {
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(activeScheme, process.execPath, [
        path.resolve(process.argv[1]),
      ]);
    } else {
      app.setAsDefaultProtocolClient(activeScheme);
    }
    log('registered protocol client', { scheme: activeScheme });
  } catch (err) {
    log('setAsDefaultProtocolClient failed', { err: String(err) });
  }

  // macOS: both cold-launch and running-app deep links arrive via 'open-url'.
  // Registered here (before ready) per competitor convention #1. If the app
  // isn't ready yet, the URL launched us → cold-start path (get_current);
  // otherwise it's a running-app URL → event path.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    const n = normalizeDeepLinkUrl(url);
    if (!n) {
      log('ignored non-abu open-url', { url });
      return;
    }
    if (app.isReady()) {
      deliverHotUrl(n);
    } else {
      coldStartUrls.push(n);
      log('queued cold-start url (open-url before ready)', { url: n });
    }
  });

  // Win/Linux cold start: the deep link is in this process's own argv.
  const fromArgv = extractDeepLinkFromArgv(process.argv);
  if (fromArgv) {
    coldStartUrls.push(fromArgv);
    log('found cold-start url in argv', { url: fromArgv });
  }
}

/**
 * A running-app deep link arrived. Surface the window and queue+flush it to the
 * renderer.
 * @param {string} url canonical abu://… (already normalized)
 */
function deliverHotUrl(url) {
  pendingHotUrls.push(url);
  try {
    const win = getWindowFn && getWindowFn();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  } catch {
    /* window may not exist yet — the flush retry covers delivery */
  }
  flushPendingDeepLinks();
}

/**
 * Emit all queued running-app deep links as one `deep-link://new-url` event
 * (payload = string[], matching the plugin's onOpenUrl contract). If no
 * subscriber has registered yet (React hasn't mounted useDeepLinkEnroll),
 * emitEvent delivers to 0 listeners — we KEEP the queue and retry when the
 * subscriber appears (tauriHost calls this from its plugin:event|listen
 * handler for this event). Idempotent and safe to call repeatedly.
 */
function flushPendingDeepLinks() {
  if (pendingHotUrls.length === 0 || !emitFn) return;
  const delivered = emitFn(NEW_URL_EVENT, pendingHotUrls.slice());
  if (delivered > 0) {
    log('delivered running-app deep links', {
      count: pendingHotUrls.length,
      subscribers: delivered,
    });
    pendingHotUrls = [];
  } else {
    log('no subscriber yet — deep links queued', { count: pendingHotUrls.length });
  }
}

/**
 * Win/Linux running-app path: the OS launches a second instance whose argv
 * carries the URL; the single-instance lock forwards that argv here.
 * @param {string[]} argv
 */
function handleSecondInstanceArgv(argv) {
  const url = extractDeepLinkFromArgv(argv);
  if (url) deliverHotUrl(url);
}

/**
 * `plugin:deep-link|get_current` — URLs that cold-launched the app. Returns
 * null (not []) when there were none: useDeepLinkEnroll does `if (!urls)
 * return`, matching the Tauri plugin's "no deep link" return.
 * @returns {string[] | null}
 */
function getCurrentDeepLinks() {
  return coldStartUrls.length > 0 ? coldStartUrls.slice() : null;
}

/** Test-only reset so headless harnesses can exercise a clean module. */
function __resetForTest() {
  coldStartUrls = [];
  pendingHotUrls = [];
  emitFn = null;
  getWindowFn = null;
  activeScheme = PROD_SCHEME;
}

module.exports = {
  initDeepLink,
  handleSecondInstanceArgv,
  flushPendingDeepLinks,
  getCurrentDeepLinks,
  normalizeDeepLinkUrl,
  extractDeepLinkFromArgv,
  NEW_URL_EVENT,
  __resetForTest,
};
