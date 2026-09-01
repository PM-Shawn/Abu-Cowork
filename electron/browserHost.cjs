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
 * - `browser_create {id,url,x,y,width,height,visible?}` → new WebContentsView,
 *   `mainWin.contentView.addChildView(view)`, `setBounds`, `loadURL`.
 *   Electron callers may pass `visible:false` so a view created under an
 *   already-open renderer dialog never paints above it.
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
 * - `browser_dispose_owner {conversationId}` → close every view that
 *   conversation owns and drop its ownership records (Electron-only; no Tauri
 *   counterpart — see `disposeOwnerViews`).
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

const { WebContentsView, session } = require('electron');
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
  'browser_capture',
  'browser_close',
  'browser_inspect_set',
  'browser_note_user_interaction',
  'browser_dispose_owner',
]);
const BROWSER_MISS = Symbol('browser-dispatch-miss');

const INSPECT_WORLD_ID = 1001;
const AUTOMATION_WORLD_ID = 1002;
const INSPECT_POLL_MS = 150;
const MAX_INSPECT_PAYLOAD_BYTES = 128 * 1024;
const INSPECT_RUNTIME_PATH = path.join(__dirname, 'browserInspectRuntime.js');
const AUTOMATION_VIEW_PREFIX = '__abu-browser-automation__';
const BROWSER_SESSION_PARTITION = 'persist:abu-browser';
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

/** WebContents whose current document has the DOM automation runtime installed. */
const automationRuntimeReady = new WeakSet();

/** Recent downloads from the isolated browser session, newest first. */
const recentDownloads = [];

let browserSession = null;
let automationRuntime = null;

/**
 * ## Tab ownership (per conversation)
 *
 * Browser automation tabs used to live in one global pool with a single
 * "current tab": two conversations driving the browser at the same time saw
 * each other's tabs in `get_tabs`, and either one's action silently moved the
 * other's current tab. Every automation view now records the conversation that
 * opened it, and every "current tab" record is keyed by that owner.
 *
 * `ownerKey` is `payload.ownerId` (the conversation id threaded down from the
 * MCP tool call) or `LEGACY_OWNER` when a caller sends none — legacy is also
 * what the user's own pane tabs get, and it stays visible to everyone so the
 * single-conversation behavior is unchanged.
 */
const LEGACY_OWNER = 'legacy';

/** view id -> { ownerKey, createdAt }. Absent ⇒ legacy (see `ownerKeyOf`). */
const viewMeta = new Map();

/** ownerKey -> webContents.id of that owner's most recently touched tab. */
const activeTabIdByOwner = new Map();

/**
 * view id -> ownerKey, for automation views awaiting renderer adoption.
 * `createAutomationView()` registers the owner BEFORE emitting
 * `browser://automation-open`, because the renderer answers by calling
 * `browser_create` with the same id — possibly before the emit even returns —
 * and `browserCreate()` is where the adopted view's meta gets written.
 */
const pendingAutomationOwners = new Map();

function ownerKeyOf(id) {
  const meta = viewMeta.get(id);
  return meta ? meta.ownerKey : LEGACY_OWNER;
}

/**
 * ## Backing off while the user takes over (R4)
 *
 * Agent tabs are adopted into the visible browser pane, so the user can grab
 * the keyboard mid-task — and used to lose: automation kept clicking and
 * filling under their hands, and the model then reasoned about a page state
 * that neither side had produced alone.
 *
 * Attribution is a plain time window. `before-input-event` and `focus` on a
 * view are the USER only while `aiActionDepth === 0`; every automation action
 * runs with that depth raised, so `keyboardAutomation`'s own
 * `webContents.focus()` + `sendInputEvent()` are excluded without needing to
 * tag individual events. The depth is deliberately GLOBAL, not per owner:
 * during owner A's action, owner B's real input is misread as automation. That
 * error is one-directional (a missed backoff, never a new block) and the window
 * is milliseconds wide, so it is accepted rather than tracked per owner.
 *
 * State-changing actions then wait for a quiet window before running. Read-only
 * ones (snapshot, get_html, the extract_ pair, screenshots, get_tabs, wait_for)
 * never wait — they are exactly what a model should do while the user works.
 */
const USER_INTERACT_QUIET_MS = 3000;
const TAKEOVER_WAIT_MS = 10000;
const TAKEOVER_POLL_MS = 500;

/** Fixed text: it tells the model to re-read the page, not to retry blindly. */
const USER_TAKEOVER_MESSAGE =
  'The user is currently interacting with this browser tab. Automation paused to avoid ' +
  'conflicting with their input. Wait for them to finish, then re-read the page state ' +
  '(snapshot) before continuing.';

const TAKEOVER_GATED_ACTIONS = new Set([
  'click',
  'fill',
  'select',
  'keyboard',
  'navigate',
  'execute_js',
  'scroll',
  'start_recording',
]);

/** ownerKey -> ts of the last input the USER landed on one of that owner's views. */
const userInteractionAt = new Map();

/** >0 while an automation action is executing — its own events are not the user. */
let aiActionDepth = 0;

/**
 * The backoff is a wall-clock wait of up to 10 seconds, which no test can sit
 * through. Both reads of "now" and the poll sleep go through this one seam so a
 * test can drive virtual time (see `__testing.setClock`).
 */
const REAL_CLOCK = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
let clock = REAL_CLOCK;

/**
 * Drop an owner's interaction record once none of its views survive, so a long
 * session does not accumulate one timestamp per conversation that ever typed.
 */
function forgetOwnerInteractionIfUnused(ownerKey) {
  for (const id of views.keys()) {
    if (ownerKeyOf(id) === ownerKey) return;
  }
  userInteractionAt.delete(ownerKey);
}

/**
 * @param {string} viewId the view the action is about to touch
 * @param {string} ownerKey that view's owner (NOT necessarily the caller's —
 *   an agent may be driving the user's own legacy pane tab, and it is the pane
 *   tab's user we must yield to)
 */
function userIsInteracting(viewId, ownerKey) {
  // Picking an element is a live, multi-second user gesture that never emits an
  // input event of its own — treat the armed session itself as "hands on".
  if (inspectSessions.has(viewId)) return true;
  const last = userInteractionAt.get(ownerKey);
  return typeof last === 'number' && clock.now() - last < USER_INTERACT_QUIET_MS;
}

async function awaitUserIdle(viewId, signal) {
  const ownerKey = ownerKeyOf(viewId);
  if (!userIsInteracting(viewId, ownerKey)) return;
  assertNotAborted(signal);
  const deadline = clock.now() + TAKEOVER_WAIT_MS;
  while (clock.now() < deadline) {
    await clock.sleep(TAKEOVER_POLL_MS);
    assertNotAborted(signal);
    if (!userIsInteracting(viewId, ownerKey)) return;
  }
  throw new Error(USER_TAKEOVER_MESSAGE);
}

/**
 * ## Backing off after HTTP 429 (R5)
 *
 * A site that starts answering with 429 is telling the automation to slow
 * down, not to keep hammering it — but nothing upstream of `execute_js`/
 * `click`/etc previously read the response status at all, so the model would
 * see a rate-limit page and immediately retry the same action, making the
 * block worse. `originBackoff` tracks one exponential window PER ORIGIN (not
 * per tab — a site rate-limits the client, not one specific view), doubling
 * 1s→2s→4s… and capping at 30s; a 2xx main-frame response clears it, since
 * that is the site telling us it is no longer objecting. Only main-frame
 * responses are inspected — a 429 from a third-party subresource (an ad, an
 * analytics ping) is not "this site" rate-limiting the automated action.
 *
 * Gated exactly where the takeover backoff (R4) is gated — reusing
 * `TAKEOVER_GATED_ACTIONS` rather than a second list — because both guards
 * answer the same question ("is it safe to act on this page right now?"),
 * just for a different hazard. Read-only actions are exactly as safe to run
 * against a rate-limiting origin as against any other page: no retry, no
 * additional load. There is deliberately no retry-after-backoff path here
 * either: the caller (the model) decides whether to wait, tell the user, or
 * give up on this step.
 */
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30000;

/** origin -> { until: ts, level: n }. Absent/expired ⇒ no backoff in effect. */
const originBackoff = new Map();

function backoffDelayForLevel(level) {
  return Math.min(BACKOFF_BASE_MS * 2 ** (level - 1), BACKOFF_CAP_MS);
}

function originOf(urlString) {
  try {
    return new URL(String(urlString || '')).origin;
  } catch {
    return null;
  }
}

function registerRateLimitHit(origin) {
  if (!origin) return;
  const existing = originBackoff.get(origin);
  const level = existing ? existing.level + 1 : 1;
  originBackoff.set(origin, { until: clock.now() + backoffDelayForLevel(level), level });
}

function clearRateLimit(origin) {
  if (!origin) return;
  originBackoff.delete(origin);
}

/**
 * Remaining backoff time for `origin` in ms; 0 when there is none, or once it
 * has expired (an expired entry is pruned here so the map does not grow
 * forever across origins that got rate-limited once and moved on).
 */
function backoffRemainingMs(origin) {
  if (!origin) return 0;
  const entry = originBackoff.get(origin);
  if (!entry) return 0;
  const remaining = entry.until - clock.now();
  if (remaining <= 0) {
    originBackoff.delete(origin);
    return 0;
  }
  return remaining;
}

/**
 * ## Abort-to-main (Stop button propagation)
 *
 * `browserAutomationHost.cjs` builds an `AbortController` per MCP request and
 * aborts it when the client connection closes early (the run was stopped).
 * The signal is threaded down through `performBrowserAutomation` into every
 * wait loop a gated action can be sitting in — the takeover backoff's poll
 * loop above, and the rate-limit gate below — so a stopped run does not sit
 * out someone else's 10-second wait before it notices.
 */
const RUN_STOPPED_MESSAGE = 'Browser action cancelled because the run was stopped.';

function assertNotAborted(signal) {
  if (signal && signal.aborted) {
    throw new Error(RUN_STOPPED_MESSAGE);
  }
}

function resolveOwnerKey(payload) {
  const raw = payload && typeof payload.ownerId === 'string' ? payload.ownerId.trim() : '';
  return raw || LEGACY_OWNER;
}

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

function browserSessionForViews() {
  if (browserSession) return browserSession;
  browserSession = session.fromPartition(BROWSER_SESSION_PARTITION, { cache: true });

  // Arbitrary sites do not get ambient device/location/notification access.
  // Future user-granted permissions must be added as an explicit product flow,
  // never by relaxing this default.
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  if (typeof browserSession.setDevicePermissionHandler === 'function') {
    browserSession.setDevicePermissionHandler(() => false);
  }
  if (typeof browserSession.setDisplayMediaRequestHandler === 'function') {
    browserSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  }

  // R5: watch main-frame responses for the 429/2xx signals that drive the
  // per-origin backoff above. Registered once per session (this function is
  // memoized via the `browserSession` singleton), covering every automation
  // view and every pane tab, since they all share `BROWSER_SESSION_PARTITION`.
  // `types: ['mainFrame']` (Electron 43's WebRequestFilter) narrows the native
  // event stream itself, on top of the `resourceType === 'mainFrame'` check
  // below — belt-and-braces, since the JS check alone still means every
  // subresource response on every page marshals into this process first.
  // NOTE: Electron allows only ONE `onHeadersReceived` listener per session —
  // registering a second one on `BROWSER_SESSION_PARTITION` anywhere else
  // would silently REPLACE this one (last registration wins), not add to it.
  browserSession.webRequest.onHeadersReceived({ urls: ['<all_urls>'], types: ['mainFrame'] }, (details, callback) => {
    if (details.resourceType === 'mainFrame') {
      const origin = originOf(details.url);
      if (details.statusCode === 429) {
        registerRateLimitHit(origin);
      } else if (details.statusCode >= 200 && details.statusCode < 300) {
        clearRateLimit(origin);
      }
    }
    callback({ cancel: false });
  });

  browserSession.on('will-download', (_event, item) => {
    const record = {
      id: `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      filename: item.getFilename(),
      url: item.getURL(),
      state: item.getState(),
      time: Date.now(),
    };
    recentDownloads.unshift(record);
    if (recentDownloads.length > 20) recentDownloads.length = 20;
    item.on('updated', () => {
      record.filename = item.getFilename();
      record.state = item.getState();
    });
    item.once('done', (_doneEvent, state) => {
      record.filename = item.getFilename();
      record.state = state;
    });
  });

  return browserSession;
}

// Only two sources are trusted: the packaged copy, and the extension's own build
// output. There is deliberately no fallback to the committed
// src-tauri/browser-extension/ bundle — that copy is synced for the Tauri bundle,
// so falling through to it would silently run a build of unknown vintage whenever
// the dev build output is missing, making DOM-layer fixes look ineffective.
function automationRuntimePath() {
  const candidates = [
    process.resourcesPath
      ? path.join(process.resourcesPath, 'browser-extension', 'content.js')
      : '',
    path.join(__dirname, '..', 'abu-chrome-extension', 'dist', 'content.js'),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function loadAutomationRuntime() {
  if (automationRuntime !== null) return automationRuntime;
  const runtimePath = automationRuntimePath();
  if (!runtimePath) {
    throw new Error(
      'browser automation runtime is missing (no content.js in the packaged resources ' +
        'or in abu-chrome-extension/dist/); build it with `npm run build:browser-extension`'
    );
  }
  try {
    automationRuntime = fs.readFileSync(runtimePath, 'utf8');
    return automationRuntime;
  } catch (error) {
    throw new Error(
      `browser automation runtime is unavailable at ${runtimePath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function configureBrowserView(id, view) {
  const contents = view.webContents;
  const automationTabId = contents.id;
  contents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (targetUrl) void contents.loadURL(targetUrl);
    return { action: 'deny' };
  });

  const resetAutomationRuntime = () => {
    automationRuntimeReady.delete(contents);
  };
  const onNav = (_event, navUrl) => {
    disarmInspect(id, false);
    emit(`browser://nav/${id}`, navUrl);
  };
  contents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) resetAutomationRuntime();
  });
  // Attribution for the takeover backoff: outside an automation action, input
  // landing here is the user working in this view's owner's tab.
  const recordUserInteraction = () => {
    if (aiActionDepth > 0) return;
    userInteractionAt.set(ownerKeyOf(id), clock.now());
  };
  contents.on('before-input-event', recordUserInteraction);
  contents.on('focus', () => {
    recordUserInteraction();
    // The user focusing a view makes it that view OWNER's current tab, never
    // anyone else's.
    activeTabIdByOwner.set(ownerKeyOf(id), automationTabId);
  });
  contents.on('did-navigate', onNav);
  contents.on('did-navigate-in-page', onNav);
  contents.once('destroyed', () => {
    automationRuntimeReady.delete(contents);
    for (const [ownerKey, tabId] of activeTabIdByOwner) {
      if (tabId === automationTabId) activeTabIdByOwner.delete(ownerKey);
    }
    // Identity guard (same as the `views` line below): a view recreated under
    // the SAME id before this teardown runs must not have its ownership record
    // wiped — that would silently downgrade the live new view to legacy and
    // hand it to every other conversation.
    if (views.get(id) === view) {
      const ownerKey = ownerKeyOf(id);
      viewMeta.delete(id);
      views.delete(id);
      forgetOwnerInteractionIfUnused(ownerKey);
    }
  });
}

/**
 * @param {unknown} tabId
 * @param {string} ownerKey the calling conversation's owner key
 * @returns {{id: string, view: import('electron').WebContentsView} | null}
 *   null when no live view has that webContents id (callers keep their own
 *   "not found" message); THROWS when the tab exists but belongs to another
 *   conversation — a silent miss there would look like "the tab vanished" and
 *   send the model into a retry loop on someone else's tab.
 */
function findViewByTabId(tabId, ownerKey = LEGACY_OWNER) {
  const numeric = Number(tabId);
  if (!Number.isInteger(numeric)) return null;
  for (const [id, view] of views) {
    const contents = view.webContents;
    if (contents && !contents.isDestroyed() && contents.id === numeric) {
      const tabOwner = ownerKeyOf(id);
      // A legacy tab (the user's own pane tab) may be driven by anyone, and
      // doing so does NOT claim it — ownership stays legacy.
      if (tabOwner !== ownerKey && tabOwner !== LEGACY_OWNER) {
        throw new Error(
          `Browser tab ${tabId} belongs to another conversation's task. ` +
            'Call get_tabs to see your own tabs, or open a new tab with navigate.'
        );
      }
      return { id, view };
    }
  }
  return null;
}

/**
 * @param {string} [ownerKey] the conversation this view is being opened for
 * @param {AbortSignal} [signal] aborts when the run that asked for this tab was
 *   stopped — checked on every iteration of the adoption wait below, so a
 *   stopped run neither sits out the rest of the wait nor ends up owning a
 *   hidden fallback view it can never close (N8).
 */
async function createAutomationView(ownerKey = LEGACY_OWNER, signal) {
  const win = mainWindow();
  if (!win || win.isDestroyed()) throw new Error('main window not found');

  const id = `${AUTOMATION_VIEW_PREFIX}-${crypto.randomBytes(8).toString('hex')}`;
  // Register the owner before emitting: the renderer's adoption calls back
  // into browserCreate() synchronously on the main process, and that is where
  // the pending owner is consumed.
  pendingAutomationOwners.set(id, ownerKey);
  // Tell the renderer WHOSE view this is: it hangs the adopted tab on that
  // conversation, so a background task's tab never lands in the conversation
  // the user happens to be looking at. LEGACY_OWNER sends no ownerId at all —
  // a legacy view belongs to the shared pool and every conversation may see it.
  emit('browser://automation-open', {
    id,
    url: 'about:blank',
    ...(ownerKey !== LEGACY_OWNER ? { ownerId: ownerKey } : {}),
  });

  // The production renderer adopts agent-created tabs into its normal browser
  // workspace so the user can watch and intervene. Headless harnesses have no
  // App listener, so fall back to a hidden view after a short bounded wait.
  const deadline = Date.now() + 2500;
  for (;;) {
    // The run may be stopped at any point during the wait; drop the pending
    // entry before throwing so a cancelled adoption cannot strand one.
    if (signal && signal.aborted) {
      pendingAutomationOwners.delete(id);
      throw new Error(RUN_STOPPED_MESSAGE);
    }
    const adopted = views.get(id);
    if (adopted?.webContents && !adopted.webContents.isDestroyed()) {
      // The requesting conversation is the authority on this view's owner —
      // browserCreate() normally wrote the same value from the pending map, and
      // if any other path got there first its guess must not win (that would
      // hand the tab to the wrong owner AND leave this caller without a current
      // tab). Same authority model as the fallback branch below.
      viewMeta.set(id, { ownerKey, createdAt: Date.now() });
      pendingAutomationOwners.delete(id);
      activeTabIdByOwner.set(ownerKey, adopted.webContents.id);
      return adopted;
    }
    // N4: `disposeOwnerViews` purges this owner's pending entries, so a missing
    // one means the owning conversation was deleted while we waited (the only
    // other remover, an adoption, is the branch just above). Building the
    // fallback view now would strand a live view no conversation can close.
    if (!pendingAutomationOwners.has(id)) throw new Error(RUN_STOPPED_MESSAGE);
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  // Adoption did not happen — drop the pending entry before anything that can
  // throw, so a failed view construction cannot strand it in the map.
  pendingAutomationOwners.delete(id);
  const view = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      session: browserSessionForViews(),
    },
  });
  viewMeta.set(id, { ownerKey, createdAt: Date.now() });
  configureBrowserView(id, view);
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1024, height: 768 });
  view.setVisible(false);
  views.set(id, view);
  activeTabIdByOwner.set(ownerKey, view.webContents.id);
  void view.webContents.loadURL('about:blank');
  return view;
}

/**
 * The tabs `ownerKey` is allowed to see: its own plus the legacy pool (the
 * user's pane tabs and any caller that sent no owner). A legacy caller sees
 * only legacy tabs — never another conversation's.
 *
 * `createIfEmpty` (default true, the historical behavior) provisions a fresh
 * automation view when the owner has none, so `get_tabs` can bootstrap a task
 * that has not opened a tab yet. Read-only probes — notably the desktop app's
 * browser permission gate, which resolves a tab's origin BEFORE deciding
 * whether the action is even allowed — pass false: a query must not be the
 * thing that opens a tab.
 *
 * @param {string} [ownerKey]
 * @param {boolean} [createIfEmpty]
 * @param {AbortSignal} [signal] forwarded to the adoption wait (see
 *   `createAutomationView`) — provisioning is the one listing path that can
 *   block for seconds, so a stopped run must not sit it out.
 */
async function automationTabs(ownerKey = LEGACY_OWNER, createIfEmpty = true, signal) {
  const tabs = [];
  for (const [id, view] of views) {
    const contents = view.webContents;
    if (!contents || contents.isDestroyed()) continue;
    if (!automationDocumentAllowed(contents.getURL())) continue;
    const tabOwner = ownerKeyOf(id);
    if (tabOwner !== ownerKey && tabOwner !== LEGACY_OWNER) continue;
    tabs.push({
      id,
      view,
      tabId: contents.id,
      url: contents.getURL(),
      title: contents.getTitle(),
    });
  }
  if (tabs.length === 0 && createIfEmpty) {
    const view = await createAutomationView(ownerKey, signal);
    tabs.push({
      id: Array.from(views.entries()).find(([, candidate]) => candidate === view)[0],
      view,
      tabId: view.webContents.id,
      url: view.webContents.getURL(),
      title: view.webContents.getTitle(),
    });
  }
  if (tabs.length > 0 && !tabs.some((tab) => tab.tabId === activeTabIdByOwner.get(ownerKey))) {
    activeTabIdByOwner.set(ownerKey, tabs[0].tabId);
  }
  return tabs;
}

function allowedAutomationUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    throw new Error('Invalid URL. Only http: and https: URLs are allowed.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Invalid URL scheme. Only http: and https: URLs are allowed.');
  }
  return parsed.href;
}

function automationDocumentAllowed(currentUrl) {
  if (!currentUrl || currentUrl === 'about:blank') return true;
  try {
    const parsed = new URL(currentUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function assertAutomationDocumentAllowed(view) {
  const currentUrl = view.webContents.getURL();
  if (!automationDocumentAllowed(currentUrl)) {
    throw new Error('Browser automation can only operate on http: and https: pages.');
  }
}

async function installAutomationRuntime(view) {
  const contents = view.webContents;
  if (contents.isDestroyed()) throw new Error('browser tab is closed');
  if (automationRuntimeReady.has(contents)) return;

  await contents.executeJavaScriptInIsolatedWorld(AUTOMATION_WORLD_ID, [{
    code: 'globalThis.__ABU_ELECTRON_BROWSER_RUNTIME__ = {};',
  }]);
  await contents.executeJavaScriptInIsolatedWorld(AUTOMATION_WORLD_ID, [{
    code: loadAutomationRuntime(),
  }]);
  const ready = await contents.executeJavaScriptInIsolatedWorld(AUTOMATION_WORLD_ID, [{
    code: 'typeof globalThis.__ABU_ELECTRON_BROWSER_RUNTIME__?.handleAction === "function"',
  }]);
  if (!ready) throw new Error('browser automation runtime failed to initialize');
  automationRuntimeReady.add(contents);
}

async function runDomAutomation(view, action, payload) {
  await installAutomationRuntime(view);
  const code = `globalThis.__ABU_ELECTRON_BROWSER_RUNTIME__.handleAction(
    ${JSON.stringify(action)},
    ${JSON.stringify(payload || {})}
  )`;
  // Never auto-retry an action: a click/fill can take effect just before its
  // execution context is replaced. Replaying it could submit or delete twice.
  // The next explicit tool call installs into the new document as needed.
  return view.webContents.executeJavaScriptInIsolatedWorld(
    AUTOMATION_WORLD_ID,
    [{ code }],
  );
}

async function navigateAutomationTab(view, payload) {
  const action = payload.action || 'goto';
  if (action === 'goto') {
    const url = allowedAutomationUrl(payload.url);
    await view.webContents.loadURL(url);
  } else if (action === 'reload') {
    view.webContents.reload();
  } else if (action === 'back') {
    view.webContents.navigationHistory.goBack();
  } else if (action === 'forward') {
    view.webContents.navigationHistory.goForward();
  } else {
    throw new Error(`Unknown navigation action: ${action}`);
  }
  return `Navigation: ${action}`;
}

function keyboardAutomation(view, payload) {
  const key = String(payload.key || '');
  if (!key) throw new Error('Keyboard key is required');
  const modifiers = Array.isArray(payload.modifiers)
    ? payload.modifiers.map((value) => {
      if (value === 'ctrl') return 'control';
      return String(value);
    })
    : [];
  view.webContents.focus();
  view.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers });
  if (key.length === 1 && !modifiers.includes('control') && !modifiers.includes('meta')) {
    view.webContents.sendInputEvent({ type: 'char', keyCode: key, modifiers });
  }
  view.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers });
  return {
    success: true,
    message: `Key press: ${modifiers.length ? `${modifiers.join('+')}+` : ''}${key}`,
  };
}

async function screenshotAutomation(view, fullPage) {
  const debug = view.webContents.debugger;
  const alreadyAttached = debug.isAttached();
  try {
    if (!alreadyAttached) debug.attach('1.3');
    if (!fullPage) {
      const capture = await debug.sendCommand('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
      });
      return `data:image/png;base64,${capture.data}`;
    }
    const metrics = await debug.sendCommand('Page.getLayoutMetrics');
    const size = metrics.cssContentSize || metrics.contentSize;
    const capture = await debug.sendCommand('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: true,
      clip: {
        x: 0,
        y: 0,
        width: Math.max(1, Math.ceil(size.width)),
        height: Math.max(1, Math.ceil(size.height)),
        scale: 1,
      },
    });
    return `data:image/png;base64,${capture.data}`;
  } finally {
    if (!alreadyAttached && debug.isAttached()) debug.detach();
  }
}

/**
 * @param {string} action
 * @param {Record<string, unknown>} [payload]
 * @param {{ signal?: AbortSignal }} [opts] `signal` aborts when the run that
 *   requested this action was stopped (see browserAutomationHost.cjs's
 *   `handleRequest`) — optional, so the existing 2-arg call sites (and their
 *   tests) are unaffected.
 */
async function performBrowserAutomation(action, payload = {}, opts) {
  const signal = opts && opts.signal;
  // Everything this call does — including creating and loading views — is
  // automation, so nothing it triggers may be mistaken for the user.
  aiActionDepth += 1;
  try {
    return await runBrowserAutomation(action, payload, signal);
  } finally {
    aiActionDepth -= 1;
  }
}

async function runBrowserAutomation(action, payload, signal) {
  // Checked before EVERYTHING else — including get_tabs/get_downloads, which
  // bypass every per-tab gate below — so a stopped run cannot still provision
  // and open a brand-new tab (or leak any other side effect) after Stop.
  assertNotAborted(signal);

  const ownerKey = resolveOwnerKey(payload);

  if (action === 'get_tabs') {
    const tabs = await automationTabs(ownerKey, payload.createIfEmpty !== false, signal);
    const win = mainWindow();
    const windowId = win && !win.isDestroyed() ? win.webContents.id : 1;
    const currentTabId = activeTabIdByOwner.get(ownerKey) ?? null;
    return {
      summary: {
        totalWindows: 1,
        totalTabs: tabs.length,
        currentWindowId: windowId,
        currentTabId,
        currentTabUrl: tabs.find((tab) => tab.tabId === currentTabId)?.url || '',
        currentTabTitle: tabs.find((tab) => tab.tabId === currentTabId)?.title || '',
        detectionStrategy: 'electron-in-app-browser',
      },
      windows: [{
        windowId,
        isCurrentWindow: true,
        tabs: tabs.map((tab) => ({
          tabId: tab.tabId,
          url: tab.url,
          title: tab.title,
          active: tab.tabId === currentTabId,
          isCurrentTab: tab.tabId === currentTabId,
        })),
      }],
    };
  }

  if (action === 'get_downloads') return recentDownloads.map((item) => ({ ...item }));

  const targetTabId = payload.tabId === undefined && action === 'get_html'
    ? activeTabIdByOwner.get(ownerKey)
    : payload.tabId;
  const match = findViewByTabId(targetTabId, ownerKey);
  if (!match) throw new Error(`Browser tab not found: ${String(targetTabId)}`);
  const { view } = match;

  if (TAKEOVER_GATED_ACTIONS.has(action)) {
    assertNotAborted(signal);

    // A `navigate` to a NEW page (the default `goto`, or an explicit one) is
    // rate-limit-checked against the URL it is ABOUT TO LOAD, not the tab's
    // current origin — otherwise a tab sitting on a backed-off site could
    // never navigate away (false block), and a tab sitting on a clean site
    // could freely navigate INTO a backed-off one (missed block: the escape
    // hatch away from a bad origin must stay open, but a fresh navigation
    // INTO it must not). Every other gated action (click/fill/.../reload/
    // back/forward) acts on the page already loaded, so it keeps checking the
    // view's current origin. An unparseable target URL yields no origin
    // (`originOf` returns null on a parse failure), so `backoffRemainingMs`
    // sees nothing to check and this gate falls through — the malformed URL
    // is still caught by `allowedAutomationUrl()` inside
    // `navigateAutomationTab()`, which is the right place to report it.
    const isGotoNavigate = action === 'navigate' && (payload.action || 'goto') === 'goto';
    const backoffOrigin = isGotoNavigate
      ? originOf(payload.url)
      : originOf(view.webContents.getURL());
    const remainingMs = backoffRemainingMs(backoffOrigin);
    if (remainingMs > 0) {
      throw new Error(
        `This site is rate-limiting automated actions (HTTP 429). Backing off for ${Math.ceil(remainingMs / 1000)}s — ` +
          'retrying immediately would make it worse. Tell the user, wait, or suggest they do this step manually.'
      );
    }

    // Step outside the AI-attribution window for the wait itself: observing the
    // user is the entire point of it, and at depth>0 their keystrokes would be
    // filed as automation's own and the wait would end after one quiet poll.
    aiActionDepth -= 1;
    try {
      await awaitUserIdle(match.id, signal);
    } finally {
      aiActionDepth += 1;
    }
  }

  activeTabIdByOwner.set(ownerKey, view.webContents.id);

  if (action === 'navigate') return navigateAutomationTab(view, payload);
  assertAutomationDocumentAllowed(view);
  if (action === 'execute_js') {
    return view.webContents.executeJavaScript(String(payload.code || ''), true);
  }
  if (action === 'screenshot') return screenshotAutomation(view, false);
  if (action === 'screenshot_full_page') return screenshotAutomation(view, true);
  if (action === 'keyboard') return keyboardAutomation(view, payload);

  const domActions = new Set([
    'snapshot',
    'get_html',
    'click',
    'fill',
    'select',
    'wait_for',
    'extract_text',
    'extract_table',
    'scroll',
    'start_recording',
    'stop_recording',
  ]);
  if (domActions.has(action)) return runDomAutomation(view, action, payload);
  throw new Error(`Unknown browser action: ${action}`);
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

function browserCreate({ id, url, x, y, width, height, visible = true }) {
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
    existing.setVisible(visible !== false);
    return null;
  }

  const view = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      session: browserSessionForViews(),
      // No `preload` — this webContents loads arbitrary untrusted sites and
      // must get zero privileged API surface (see module header).
    },
  });

  // An id the renderer is adopting on behalf of an automation call carries a
  // pending owner (see createAutomationView); anything else — a tab the user
  // opened in the pane — is legacy and stays visible to every caller.
  const ownerKey = pendingAutomationOwners.get(id) ?? LEGACY_OWNER;
  pendingAutomationOwners.delete(id);
  viewMeta.set(id, { ownerKey, createdAt: Date.now() });

  configureBrowserView(id, view);

  const shouldShow = visible !== false;
  // Preserve Electron's proven add-then-bounds order. If a renderer dialog is
  // already open, hide synchronously in the same main-process call before IPC
  // returns; pre-hiding an unattached macOS WebContentsView can prevent it from
  // entering window composition when it is shown later.
  win.contentView.addChildView(view);
  view.setBounds(toRect(x, y, width, height));
  if (!shouldShow) view.setVisible(false);
  views.set(id, view);
  activeTabIdByOwner.set(ownerKey, view.webContents.id);

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

/**
 * Capture the view's current frame as a data URL. Used by the renderer to
 * freeze-frame the pane right before hiding the native view for an overlay
 * (modal/menu) — without it the pane flashes to blank white, since the
 * native view paints above React and hiding it reveals the empty placeholder.
 * Same idea as Claude desktop's "warm capture" before a preview hides.
 * Returns null when the view is gone or the capture fails — callers fall
 * back to the blank placeholder rather than blocking the hide.
 */
async function browserCapture({ id }) {
  const view = getView(id);
  if (!view || !view.webContents || view.webContents.isDestroyed()) return null;
  try {
    const image = await view.webContents.capturePage();
    if (image.isEmpty()) return null;
    return image.toDataURL();
  } catch {
    return null;
  }
}

function browserShow({ id }) {
  const view = getView(id);
  if (view) {
    view.setVisible(true);
    // The user switching pane tabs updates that tab OWNER's current tab only.
    if (view.webContents) activeTabIdByOwner.set(ownerKeyOf(id), view.webContents.id);
  }
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
    const contents = view.webContents;
    if (contents && !contents.isDestroyed()) {
      contents.close();
    }
  } catch {
    /* already gone — best-effort */
  }
  const ownerKey = ownerKeyOf(id);
  views.delete(id);
  // `destroyed` also clears these, but it never fires when the window is torn
  // down under us (app quit) — don't leak the ownership record.
  viewMeta.delete(id);
  pendingAutomationOwners.delete(id);
  forgetOwnerInteractionIfUnused(ownerKey);
}

function browserClose({ id }) {
  const view = getView(id);
  if (view) closeView(id, view);
  return null;
}

/**
 * N4 — tear down everything one conversation owns.
 *
 * Deleting a conversation used to leave its agent's browser views running for
 * the rest of the session: no conversation's tab strip listed them, so nothing
 * could close them, while main kept a live `WebContentsView` (and the renderer
 * a mounted `BrowserTab` syncing its bounds) per deleted conversation.
 *
 * The renderer's delete cascade removes those tab records, which already
 * destroys the views it knows about; this command is the belt-and-braces half
 * for main-side state no tab record covers — a headless fallback view (no
 * renderer ever adopted it), or an adoption still pending when the delete
 * landed. Scope is exactly one owner: another conversation's views and the
 * LEGACY pool (the user's own pane tabs, which every conversation may see) are
 * never touched, so an unknown/blank/legacy owner is a deliberate no-op rather
 * than an error — like `browser_hide`/`browser_close`, this is a cleanup
 * command whose failure mode must never be "kill someone else's tab".
 */
function disposeOwnerViews(ownerKey) {
  // Snapshot: closeView deletes from `views` as we go.
  for (const [id, view] of Array.from(views)) {
    if (ownerKeyOf(id) === ownerKey) closeView(id, view);
  }
  // closeView already drops these per view (and `forgetOwnerInteractionIfUnused`
  // clears the interaction record once the owner's last view is gone), but the
  // owner may also hold records with no live view behind them — a current-tab
  // id whose view was destroyed by the window teardown, or a pending adoption.
  activeTabIdByOwner.delete(ownerKey);
  userInteractionAt.delete(ownerKey);
  for (const [pendingId, pendingOwner] of Array.from(pendingAutomationOwners)) {
    if (pendingOwner === ownerKey) pendingAutomationOwners.delete(pendingId);
  }
}

function browserDisposeOwner({ conversationId }) {
  const ownerKey = typeof conversationId === 'string' ? conversationId.trim() : '';
  if (!ownerKey || ownerKey === LEGACY_OWNER) return null;
  disposeOwnerViews(ownerKey);
  return null;
}

/**
 * N3 — React-layer takeover signal.
 *
 * The takeover backoff (R4, above) only hears the USER on the guest
 * webContents itself (`before-input-event` / `focus`): typing in the address
 * bar or clicking back/forward/reload happens in the MAIN window's React
 * layer (`BrowserTab.tsx`), which never touches the guest webContents, so
 * none of it produced a signal — automation could act while the user was
 * mid-navigation. `BrowserTab.tsx` calls this on address-bar focus/input and
 * nav-button clicks; it records presence exactly like `recordUserInteraction`
 * does for real input, reusing the same map/clock rather than adding new
 * state. An unknown id (a tab that already closed under a stale ref) is a
 * silent no-op — this is a best-effort presence ping, not a validated
 * command.
 */
function browserNoteUserInteraction({ id }) {
  const view = getView(id);
  if (!view) return null;
  userInteractionAt.set(ownerKeyOf(id), clock.now());
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
    case 'browser_capture':
      return browserCapture(a);
    case 'browser_close':
      return browserClose(a);
    case 'browser_inspect_set':
      return browserInspectSet(a);
    case 'browser_note_user_interaction':
      return browserNoteUserInteraction(a);
    case 'browser_dispose_owner':
      return browserDisposeOwner(a);
    default:
      return BROWSER_MISS;
  }
}

/** No orphans: tear down every live browser view on app quit. */
function closeAllBrowserViews() {
  for (const [id, view] of views) {
    closeView(id, view);
  }
  const { stopBrowserAutomationServer } = require('./browserAutomationHost.cjs');
  stopBrowserAutomationServer();
}

module.exports = {
  browserDispatch,
  BROWSER_MISS,
  closeAllBrowserViews,
  performBrowserAutomation,
  __testing: {
    /** Swap the takeover backoff's clock; pass nothing to restore wall time. */
    setClock(next) { clock = next || REAL_CLOCK; },
  },
};
