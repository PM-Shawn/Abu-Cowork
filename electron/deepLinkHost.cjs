/**
 * Deep-link host — the Electron equivalent of tauri_plugin_deep_link.
 *
 * Abu deep links today:
 *   - `abu://enroll?server=<url>&token=<token>` — pre-fill enterprise bind
 *   - `abu://open?server=<url>` — browser asks the client to start OAuth
 *   - `abu://auth?code=<once>&state=<csrf>` — account OAuth callback
 * The frontend consumes accepted links via `@tauri-apps/plugin-deep-link`:
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
const { name: PACKAGE_NAME } = require('../package.json');

const PROD_SCHEME = 'abu';
const DEV_SCHEME = 'abu-dev';
const NEW_URL_EVENT = 'deep-link://new-url';

// Known deep-link actions. New hosts must be added here so the whitelist
// keeps rejecting everything else.
const KNOWN_HOSTS = new Set(['enroll', 'open', 'auth']);

let activeScheme = PROD_SCHEME;
let coldStartUrls = []; // URLs that cold-launched the app (get_current path)
let pendingHotUrls = []; // running-app URLs awaiting a renderer subscriber
let emitFn = null; // injected tauriHost.emitEvent (returns delivered count)
let getWindowFn = null; // injected tauriHost.getMainWindow
let appInstance = null; // Electron app, needed to activate macOS from the browser

function registrationTarget() {
  if (process.defaultApp && process.argv.length >= 2) {
    return {
      executablePath: process.execPath,
      args: [path.resolve(process.argv[1])],
    };
  }
  return null;
}

function log(msg, extra) {
  console.log(`[deepLink] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`);
}

// Authorization codes and CSRF state must never enter logs. Keep the existing
// enroll logging behavior unchanged because support workflows rely on it.
function safeUrlLogDetails(raw) {
  if (typeof raw === 'string') {
    const candidate = raw.trim().replace(/^abu-dev:/i, 'abu:');
    // Parse-independent guard: malformed OAuth callbacks (for example an
    // invalid port) still contain secrets and must not fall back to raw logs.
    const sensitiveHost = /^abu:(?:\/\/)?(?:[^/?#]*@)?(auth|login)(?:[/?#:%.]|$)/i.exec(candidate)?.[1];
    if (sensitiveHost) {
      return { host: sensitiveHost.toLowerCase() };
    }
    try {
      const url = new URL(candidate);
      if (url.protocol === 'abu:' && (url.hostname === 'auth' || url.hostname === 'login')) {
        return { host: url.hostname };
      }
    } catch {
      // Fall through to the existing raw-value diagnostics for unrelated input.
    }
  }
  return { url: raw };
}

/**
 * Normalize a raw URL string to the canonical `abu://…` form, or return null
 * if it is not one of our schemes / not a known action. This is the ONE parser
 * all three arrival sources funnel through (competitor convention #2/#3).
 * @param {unknown} raw
 * @param {boolean} [allowDevScheme] testable form of the packaged-app gate
 * @returns {string | null}
 */
function normalizeDeepLinkUrl(raw, allowDevScheme = activeScheme === DEV_SCHEME) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  // Windows may hand us "abu://…" or (rarely) "abu:…"; accept both forms.
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(s);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  if (scheme !== PROD_SCHEME && scheme !== DEV_SCHEME) return null;
  if (scheme === DEV_SCHEME) {
    if (!allowDevScheme) return null;
    // abu-dev://…  →  abu://…  (rewrite the dev scheme to the canonical one)
    s = PROD_SCHEME + s.slice(m[1].length);
  }
  try {
    const u = new URL(s);
    if (u.protocol !== 'abu:') return null;
    if (!KNOWN_HOSTS.has(u.hostname)) return null; // reject unknown actions
    // ShellExecute normalizes the URL before handing it to a Windows protocol
    // handler, so a browser callback arrives as `abu://auth/?code=…`. An empty
    // path and the root path both mean "no path"; only a real path is rejected.
    if (u.hostname === 'auth'
      && (u.username || u.password || u.port || u.hash
        || (u.pathname !== '' && u.pathname !== '/'))) {
      return null;
    }
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
 * Only the canonical packaged product may claim the production scheme.
 * Isolated E2E/fork packages intentionally use a different package name and
 * must not replace an installed Abu's HKCU protocol command at runtime.
 * Unpackaged development keeps its separate `abu-dev` registration.
 * @param {import('electron').App} app
 * @param {string} packageName
 */
function shouldRegisterProtocolClient(app, packageName = PACKAGE_NAME) {
  if (!app.isPackaged) return true;
  return typeof packageName === 'string'
    && packageName.trim().toLowerCase() === 'abu';
}

/**
 * Which scheme this shell owns. Single source of truth for the packaged/dev
 * split — anything that needs to know (protocol registration below, and the
 * scheme handed to the renderer so it can build an OAuth `redirect_uri` the OS
 * will route back to THIS shell) must go through here rather than re-deriving
 * it from `app.isPackaged`.
 * @param {import('electron').App} appInstance
 * @returns {string}
 */
function resolveDeepLinkScheme(appInstance) {
  return appInstance.isPackaged ? PROD_SCHEME : DEV_SCHEME;
}

/** The scheme actually registered (PROD_SCHEME until initDeepLink runs). */
function getActiveScheme() {
  return activeScheme;
}

/**
 * Wire deep-link handling. MUST be called before app 'ready' so the early
 * `open-url` listener is in place when the OS delivers a launching URL.
 * @param {import('electron').App} app
 * @param {{ emitEvent: (event: string, payload: unknown) => number, getMainWindow: () => import('electron').BrowserWindow | null }} deps
 */
function initDeepLink(app, deps) {
  appInstance = app;
  emitFn = deps.emitEvent;
  getWindowFn = deps.getMainWindow;
  activeScheme = resolveDeepLinkScheme(app);

  // macOS development registration belongs to mac-protocol-shell.mjs, which
  // verifies the exact app path and unique checkout bundle ID. Generic Electron
  // runners (including E2E) must not overwrite it with com.github.Electron.
  // Windows still needs the executable + entry script; packaged apps own abu://.
  //
  // The second half is the packaged side of the same rule: an isolated E2E or
  // fork package carries a different package name on purpose, and must not
  // replace an installed Abu's HKCU protocol command either.
  const ownsRegistration = (process.platform !== 'darwin' || app.isPackaged)
    && shouldRegisterProtocolClient(app);
  if (ownsRegistration) {
    try {
      const target = registrationTarget();
      const registered = target
        ? app.setAsDefaultProtocolClient(activeScheme, target.executablePath, target.args)
        : app.setAsDefaultProtocolClient(activeScheme);
      log(registered ? 'registered protocol client' : 'protocol registration declined', { scheme: activeScheme });
    } catch (err) {
      log('setAsDefaultProtocolClient failed', { err: String(err) });
    }
  } else {
    log('skipped protocol registration', { scheme: activeScheme });
  }

  // macOS: both cold-launch and running-app deep links arrive via 'open-url'.
  // Registered here (before ready) per competitor convention #1. If the app
  // isn't ready yet, the URL launched us → cold-start path (get_current);
  // otherwise it's a running-app URL → event path.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    const n = normalizeDeepLinkUrl(url);
    if (!n) {
      log('ignored non-abu open-url', safeUrlLogDetails(url));
      return;
    }
    if (app.isReady()) {
      deliverHotUrl(n);
    } else {
      coldStartUrls.push(n);
      log('queued cold-start url (open-url before ready)', safeUrlLogDetails(n));
    }
  });

  // Win/Linux cold start: the deep link is in this process's own argv.
  const fromArgv = extractDeepLinkFromArgv(process.argv);
  if (fromArgv) {
    coldStartUrls.push(fromArgv);
    log('found cold-start url in argv', safeUrlLogDetails(fromArgv));
  }
}

/**
 * Whether this exact Electron shell is the current handler for its active
 * scheme. `false` means another handler currently owns it; query failures are
 * allowed to throw so the renderer can represent an unknown state honestly.
 * @param {import('electron').App} app
 * @returns {boolean}
 */
function isCurrentSchemeRegistered(app) {
  if (!app.isReady()) throw new Error('deep_link_registration_not_ready');
  const target = registrationTarget();
  if (target) {
    return app.isDefaultProtocolClient(activeScheme, target.executablePath, target.args);
  }
  return app.isDefaultProtocolClient(activeScheme);
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
      // On macOS, focusing a BrowserWindow does not necessarily activate the
      // application when the URL came from a foreground browser. Explicitly
      // reclaim app focus so an OAuth callback visibly returns to Abu.
      if (process.platform === 'darwin' && typeof appInstance?.focus === 'function') {
        appInstance.focus({ steal: true });
      }
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
  appInstance = null;
  activeScheme = PROD_SCHEME;
}

module.exports = {
  initDeepLink,
  handleSecondInstanceArgv,
  flushPendingDeepLinks,
  getCurrentDeepLinks,
  isCurrentSchemeRegistered,
  normalizeDeepLinkUrl,
  extractDeepLinkFromArgv,
  shouldRegisterProtocolClient,
  resolveDeepLinkScheme,
  getActiveScheme,
  NEW_URL_EVENT,
  __resetForTest,
};
