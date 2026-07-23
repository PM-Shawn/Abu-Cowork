/**
 * Electron main-side Tauri-IPC command router (Phase 2 slice A: production;
 * slice B: event bridge).
 *
 * Provides real handlers for the boot-blocking core surface the frontend
 * calls at startup: `@tauri-apps/plugin-os` internals (synchronous, must
 * exist before page scripts run) and `@tauri-apps/plugin-path` command
 * family (BaseDirectory resolution + path helpers). Slice B adds the
 * `plugin:event|*` family (listen/unlisten/emit/emit_to) with a real
 * subscription registry, so `listen()`/`emit()` route through main and main
 * can push events (window focus/blur/close-requested, future streamed data)
 * back to renderer-registered callbacks via `emitEvent()`. Slice C adds the
 * 7 `secret_*` commands, backed by electron/secretStore.cjs (safeStorage).
 * Slice D adds the window family (`plugin:window|set_theme|set_title|
 * is_focused|set_badge_count|outer_position|start_dragging|close`) plus the
 * app/window custom commands (`app_exit`/`window_hide`/`window_show`), and
 * closes the loop on preventable-close: main.cjs's `win.on('close')` emits
 * the app-custom `close-requested` event instead of letting Electron close
 * the window outright, and the frontend's existing closeAction routing
 * (App.tsx) decides whether that becomes a real `app_exit`, a `window_hide`,
 * or a confirm dialog. Everything else falls back to a benign stub (mirrors
 * electron/spike/tauriShimPreload.cjs's defaultFor pattern) so the frontend
 * can boot past this layer — later slices (E+) replace individual stubs
 * with real handlers.
 *
 * Wired from electron/main.cjs via registerTauriHost(app) BEFORE the
 * BrowserWindow is created (the preload's synchronous os-internals fetch
 * needs the 'tauri:os-internals' handler registered first).
 */
'use strict';

const { ipcMain, nativeTheme, screen, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { abuAppDataDir, REPO_ROOT } = require('./appEnv.cjs');
const { initSecretStore, secretDispatch } = require('./secretStore.cjs');
const { fsDispatch, FS_MISS } = require('./fsHost.cjs');
const { fsWatchDispatch, FS_WATCH_MISS } = require('./fsWatchHost.cjs');
const { mcpDispatch } = require('./mcpBridge.cjs');
const { desktopDispatch, DESKTOP_MISS } = require('./desktopHost.cjs');
const { nativeHelperDispatch, NATIVE_HELPER_MISS } = require('./nativeHelperManager.cjs');
const { ptyDispatch, PTY_MISS } = require('./ptyHost.cjs');
// browserHost.cjs requires THIS module back (for emitEvent/getMainWindow),
// but only lazily (inside function bodies, called at dispatch-time, never
// at module-load-time) — so requiring it eagerly here, same as the other
// dispatch families, doesn't deadlock on the circular pair.
const { browserDispatch, BROWSER_MISS, closeAllBrowserViews } = require('./browserHost.cjs');
// guiHost.cjs (GUI-families slice) — same lazy-back-require pattern as
// browserHost.cjs: it needs emitEvent/getMainWindow/requestAppExit from this
// module, required lazily inside its own function bodies.
const { guiDispatch, GUI_MISS, initGuiHost, teardownGuiHost } = require('./guiHost.cjs');
const { previewDispatch, PREVIEW_MISS } = require('./previewServer.cjs');
const { catalogDispatch, CATALOG_MISS } = require('./catalogDb.cjs');
const { noticeDispatch, NOTICE_MISS } = require('./noticeDb.cjs');
const { commandDispatch, COMMAND_MISS } = require('./commandHost.cjs');
const { triggerDispatch, TRIGGER_MISS } = require('./triggerServer.cjs');
const { networkProxyDispatch, NETWORK_PROXY_MISS } = require('./networkProxy.cjs');
const { httpDispatch, HTTP_MISS } = require('./httpHost.cjs');

// Window-family state (Phase 2 slice D). `mainWindow` is set by main.cjs right
// after createWindow() via setMainWindow(); `quitting` is the standard
// isQuitting guard so app_exit's app.quit() doesn't re-trigger the
// preventable-close handler (win.on('close') in main.cjs) into an infinite
// prevent-loop.
let mainWindow = null;
let quitting = false;

/** @param {import('electron').BrowserWindow} win */
function setMainWindow(win) {
  mainWindow = win;
}

/**
 * @returns the tracked main window, or `null` if none is set / it has been
 *   destroyed. Added for browserHost.cjs (Phase 2 slice — in-app browser
 *   tab): `WebContentsView`s must be attached to a real window's
 *   `contentView`, and browserHost has no other route to it (it isn't
 *   passed `app`-adjacent window state the way windowDispatch is).
 */
function getMainWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

function isQuitting() {
  return quitting;
}

/**
 * Shared "real quit" path — flips the isQuitting guard BEFORE app.quit() so
 * the preventable-close handler lets it through instead of re-preventing it
 * (see wireWindowEvents' `win.on('close', ...)`). Used by windowDispatch's
 * `app_exit` command AND guiHost.cjs's tray "Quit" menu item, so both quit
 * paths share the exact same no-infinite-prevent-loop guard.
 * @param {import('electron').App} app
 */
function requestAppExit(app) {
  quitting = true;
  app.quit();
}

/** True iff any live subscription exists for `event`. */
function hasListeners(event) {
  for (const sub of subscriptions.values()) {
    if (sub.event === event) return true;
  }
  return false;
}

/**
 * Wire an Electron window's lifecycle to the Tauri event/close contract.
 * Shared by main.cjs (production) and the boot-verify harness, so the harness
 * exercises the REAL close-handling wiring rather than a stale copy.
 * @param {import('electron').BrowserWindow} win
 */
function wireWindowEvents(win) {
  setMainWindow(win);
  win.on('focus', () => emitEvent('tauri://focus', null));
  win.on('blur', () => emitEvent('tauri://blur', null));
  // Preventable close (slice D), guarded twice:
  //  - `quitting`: a REAL quit (OS Cmd+Q / menu Quit → before-quit, or app_exit)
  //    must NOT be prevented, or the app becomes un-quittable.
  //  - hasListeners('close-requested'): before the frontend registers its
  //    close handler (early startup), don't preventDefault into a dead emit —
  //    that swallows the close click (window neither closes nor prompts) until
  //    the app finishes loading. No listener yet → let the close proceed.
  win.on('close', (e) => {
    if (quitting) return;
    if (!hasListeners('close-requested')) return;
    e.preventDefault();
    emitEvent('close-requested', null);
  });
  // Purge this renderer's subscriptions on reload (WebContents survives, no
  // unlisten fires, the preload callbackId counter resets → stale subs would
  // cross-wire to the reloaded page's colliding ids).
  win.webContents.on('did-start-loading', () => clearSubscriptionsForSender(win.webContents));
}

// Tauri BaseDirectory enum (numeric -> meaning). See @tauri-apps/api/path.
const BaseDirectory = Object.freeze({
  Audio: 1,
  Cache: 2,
  Config: 3,
  Data: 4,
  LocalData: 5,
  Document: 6,
  Download: 7,
  Picture: 8,
  Public: 9,
  Video: 10,
  Resource: 11,
  Temp: 12,
  AppConfig: 13,
  AppData: 14,
  AppLocalData: 15,
  AppCache: 16,
  AppLog: 17,
  Desktop: 18,
  Home: 21,
  Runtime: 22,
  Template: 23,
  Executable: 19,
  Font: 20,
});

/** @param {import('electron').App} app */
function osInternals(app) {
  void app;
  const platformMap = { darwin: 'macos', win32: 'windows' };
  const archMap = { arm64: 'aarch64', x64: 'x86_64' };
  const platform = platformMap[process.platform] || process.platform;
  const arch = archMap[process.arch] || process.arch;
  const family = process.platform === 'win32' ? 'windows' : 'unix';
  return {
    platform,
    os_type: platform,
    arch,
    family,
    version: os.release(),
    exe_extension: process.platform === 'win32' ? 'exe' : '',
    eol: process.platform === 'win32' ? '\r\n' : '\n',
  };
}

/** Dirs already mkdir'd this process — avoids a blocking mkdirSync per resolution. */
const mkdirDone = new Set();

/**
 * OS cache root (evictable), matching Tauri's cacheDir. Electron's app.getPath
 * has NO 'cache' key, and 'sessionData' is the PERSISTENT userData region — so
 * cache files there would never be OS-evicted. Resolve the real per-OS cache dir.
 */
function osCacheDir() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches');
  if (process.platform === 'win32') return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
}

/**
 * BaseDirectory number -> absolute path.
 * @param {import('electron').App} app
 * @param {number} n
 */
function baseDir(app, n) {
  const appScopedDirs = [
    BaseDirectory.AppData,
    BaseDirectory.AppConfig,
    BaseDirectory.AppLocalData,
    BaseDirectory.AppCache,
    BaseDirectory.AppLog,
  ];
  let resolved;
  switch (n) {
    case BaseDirectory.Home:
      resolved = app.getPath('home');
      break;
    case BaseDirectory.AppData:
    case BaseDirectory.AppConfig:
    case BaseDirectory.AppLocalData:
      resolved = abuAppDataDir(app);
      break;
    case BaseDirectory.AppCache:
      resolved = path.join(abuAppDataDir(app), 'Cache');
      break;
    case BaseDirectory.AppLog:
      resolved = app.getPath('logs');
      break;
    case BaseDirectory.Config:
    case BaseDirectory.Data:
    case BaseDirectory.LocalData:
      resolved = app.getPath('appData');
      break;
    case BaseDirectory.Cache:
      resolved = osCacheDir();
      break;
    case BaseDirectory.Temp:
    case BaseDirectory.Runtime:
      resolved = app.getPath('temp');
      break;
    case BaseDirectory.Document:
      resolved = app.getPath('documents');
      break;
    case BaseDirectory.Download:
      resolved = app.getPath('downloads');
      break;
    case BaseDirectory.Picture:
      resolved = app.getPath('pictures');
      break;
    case BaseDirectory.Video:
      resolved = app.getPath('videos');
      break;
    case BaseDirectory.Audio:
      resolved = app.getPath('music');
      break;
    case BaseDirectory.Desktop:
      resolved = app.getPath('desktop');
      break;
    case BaseDirectory.Public:
    case BaseDirectory.Template:
      resolved = app.getPath('home');
      break;
    case BaseDirectory.Resource:
      // $RESOURCE = the dir that contains bundled resources (notably sidecar/).
      // In dev that's the repo root (where resolveResource('sidecar/index.mjs')
      // must land so the frontend's sidecarManager can spawn the sidecar);
      // ABU_RESOURCE_DIR is set to the same. Packaged would use resourcesPath —
      // a later packaging concern.
      resolved = REPO_ROOT;
      break;
    case BaseDirectory.Executable:
      resolved = path.dirname(app.getPath('exe'));
      break;
    case BaseDirectory.Font:
      resolved = path.join(app.getPath('home'), 'Library/Fonts');
      break;
    default:
      resolved = app.getPath('home');
      break;
  }

  if (appScopedDirs.includes(n) && !mkdirDone.has(resolved)) {
    try {
      fs.mkdirSync(resolved, { recursive: true });
      mkdirDone.add(resolved);
    } catch {
      /* best-effort; downstream fs ops will surface a real error if this fails */
    }
  }

  return resolved;
}

const seenUnknownCmds = new Set();

// Event subscription registry (Phase 2 slice B). eventId -> {event, callbackId, sender}.
// `sender` is the ipcMain event.sender (a WebContents) the subscribing renderer
// lives on, so delivery can target the right window (multi-window aware even
// though slice B only ever has one).
let nextEventId = 1;
const subscriptions = new Map();

/**
 * Deliver a `plugin:event|emit`-style event to every matching subscription's
 * renderer. The callback (registered via preload's transformCallback) is
 * invoked with a Tauri Event object: {event, id, payload}.
 * @param {string} event
 * @param {unknown} payload
 */
function deliver(event, payload) {
  for (const [eventId, sub] of subscriptions) {
    if (sub.event !== event) continue;
    if (!sub.sender || sub.sender.isDestroyed()) {
      subscriptions.delete(eventId);
      continue;
    }
    sub.sender.send('tauri:callback', {
      id: sub.callbackId,
      payload: { event, id: eventId, payload },
    });
  }
}

/**
 * Main-side helper for Electron-originated events (window focus/blur/close,
 * future streamed data) to reach renderer-registered `listen()` callbacks.
 *
 * NOTE on once(): this bridge is not once-aware — @tauri-apps/api's once()
 * unlistens via an async `plugin:event|unlisten` IPC round-trip AFTER the first
 * delivery (event.js fires `void _unlisten(...)` then the handler), so two
 * emits of the same event in the same burst can both deliver before the
 * unlisten is processed, double-firing a one-shot handler. This matches
 * upstream Tauri's own fire-and-forget once() semantics (the JS wrapper, not
 * the backend, drives the unlisten) — not a divergence introduced here.
 * @param {string} event
 * @param {unknown} payload
 */
function emitEvent(event, payload) {
  deliver(event, payload);
}

/**
 * Drop every subscription owned by a given WebContents. Called on renderer
 * reload (main.cjs wires webContents 'did-start-loading'): a reload doesn't
 * destroy the WebContents or fire unlisten, and the reloaded page's preload
 * resets its callbackId counter — so stale subscriptions would cross-wire to
 * the fresh page's colliding ids. The reloaded page is gone, so there's no
 * preload callback to notify (unlike unlisten).
 * @param {import('electron').WebContents} sender
 */
function clearSubscriptionsForSender(sender) {
  for (const [eventId, sub] of subscriptions) {
    if (sub.sender === sender) subscriptions.delete(eventId);
  }
}

// Commands whose real handler isn't wired yet (next-layer slices B-E) but
// whose callers immediately array-iterate the result (`.filter`/`.length`)
// without a defensive null-check — an empty array is both truthful (nothing
// stubbed-out can have entries yet) and keeps these boot-time consumers
// (memdir migration scan, notice inbox drain) from throwing. Named
// explicitly rather than widening the generic list/_all regex below, since
// these don't share that naming convention.
const ARRAY_RESULT_CMDS = new Set(['plugin:fs|read_dir', 'notice_inbox_pending']);

function defaultFor(cmd) {
  // Log EVERY stubbed command once — including the []/false shapes — so a
  // not-yet-wired command is never silently indistinguishable from a real
  // empty/false result (review slice-A [3]/[6]). These stubs are temporary
  // scaffolding for the boot-clean milestone; slices B-E replace each with a
  // real handler (plugin:event|* is now real — see registerTauriHost below).
  // NOTE: a stubbed *mutation* (fs write, secret_set, …) returning
  // null still reads as success to its caller — tolerated only because this is a
  // dev-integration harness with no real user data, and those write commands get
  // real handlers in slices C-E.
  if (!seenUnknownCmds.has(cmd)) {
    seenUnknownCmds.add(cmd);
    console.log(`[tauriHost] stub: ${cmd}`);
  }
  if (ARRAY_RESULT_CMDS.has(cmd)) return [];
  if (/(^|_)list$|failed_keys|_all$/i.test(cmd)) return [];
  if (/_has$|_exists$|^is_|^check_/i.test(cmd)) return false;
  return null;
}

// Window-plugin + app/window commands handled against `mainWindow` (Phase 2
// slice D). Returns a sentinel (WINDOW_DISPATCH_MISS) when `cmd` isn't one of
// these, so the caller can fall through to dispatch()/stub without this
// function needing to know the rest of the command surface.
const WINDOW_DISPATCH_MISS = Symbol('window-dispatch-miss');

/**
 * @param {import('electron').App} app
 * @param {string} cmd
 * @param {Record<string, unknown>} args
 * @param {import('electron').BrowserWindow | null} [callerWin] The REAL
 *   window that sent this invoke (resolved via
 *   `BrowserWindow.fromWebContents(e.sender)` in the ipcMain handler below).
 *   Used only for the read/per-window-state commands (set_title, is_focused,
 *   outer_position) — see module header on why: `@tauri-apps/api`'s
 *   `getCurrentWindow()` targets "whichever window is asking" (e.g. the pet
 *   window reading its OWN position for placement math), but every window
 *   shares the same preload.cjs, which hardcodes
 *   `metadata.currentWindow.label = 'main'`, so those commands can't
 *   disambiguate by label the way Tauri does — resolving the actual sender
 *   window here is the fix. app_exit/window_hide/window_show/
 *   plugin:window|close intentionally keep targeting the tracked
 *   `mainWindow` regardless of `callerWin` — those are main-window-lifecycle
 *   commands ("the app window"), not "whichever window called", and nothing
 *   besides the main window invokes them today.
 */
function windowDispatch(app, cmd, args, callerWin) {
  const a = args || {};
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const queryWin = callerWin && !callerWin.isDestroyed() ? callerWin : win;
  switch (cmd) {
    case 'plugin:window|set_theme':
      // value is 'light'|'dark'|null/undefined (null/undefined = follow system).
      nativeTheme.themeSource = a.value === 'light' || a.value === 'dark' ? a.value : 'system';
      return null;
    case 'plugin:window|set_title':
      if (queryWin) queryWin.setTitle(String(a.title ?? ''));
      return null;
    case 'plugin:window|is_focused':
      return queryWin ? queryWin.isFocused() : false;
    case 'plugin:window|set_badge_count':
      // macOS dock badge only; Windows/Linux have no equivalent in Electron's
      // cross-platform API (Windows would need setOverlayIcon per-window).
      app.setBadgeCount(Number(a.count) || 0);
      return null;
    case 'plugin:window|outer_position': {
      if (!queryWin) return { x: 0, y: 0 };
      // Tauri's outerPosition() contract is PHYSICAL pixels; Electron's
      // getPosition() is device-independent (DIP). Scale by the window's
      // display factor so HiDPI consumers (pet placement, popover anchoring,
      // window position persist/restore) aren't off by the scale factor.
      const [x, y] = queryWin.getPosition();
      const sf = screen.getDisplayMatching(queryWin.getBounds()).scaleFactor || 1;
      return { x: Math.round(x * sf), y: Math.round(y * sf) };
    }
    case 'plugin:window|primary_monitor': {
      // Tauri's Monitor: size/position in PHYSICAL px + scaleFactor. Electron's
      // Display gives size/bounds in DIP, so scale up. Pet placement
      // (PetApp.tsx primaryMonitor()) reads mon.size.width / scaleFactor.
      const d = screen.getPrimaryDisplay();
      const sf = d.scaleFactor || 1;
      return {
        name: null,
        size: { width: Math.round(d.size.width * sf), height: Math.round(d.size.height * sf) },
        position: { x: Math.round(d.bounds.x * sf), y: Math.round(d.bounds.y * sf) },
        scaleFactor: sf,
      };
    }
    case 'plugin:window|start_dragging':
      // Electron drags windows via CSS `-webkit-app-region: drag`, not an IPC
      // call — no-op here. (The desktop-pet window's startDragging()-based drag
      // therefore doesn't move it yet — tracked as a known gap.)
      return null;
    case 'plugin:window|close':
      if (win) win.close(); // routes through the preventable-close handler in main.cjs
      return null;
    case 'app_exit':
      requestAppExit(app);
      return null;
    case 'window_hide':
      if (win) win.hide();
      return null;
    case 'window_show':
      if (win) {
        win.show();
        win.focus();
      }
      return null;
    default:
      return WINDOW_DISPATCH_MISS;
  }
}

/**
 * @param {import('electron').App} app
 * @param {string} cmd
 * @param {Record<string, unknown>} args
 */
function dispatch(app, cmd, args) {
  const a = args || {};
  switch (cmd) {
    case 'plugin:path|resolve_directory': {
      const dir = baseDir(app, a.directory);
      if (typeof a.path === 'string' && a.path.length > 0) {
        return path.join(dir, a.path);
      }
      return dir;
    }
    case 'plugin:path|resolve':
      return path.resolve(...(a.paths || []));
    case 'plugin:path|join':
      return path.join(...(a.paths || []));
    case 'plugin:path|normalize':
      return path.normalize(a.path || '');
    case 'plugin:path|dirname':
      return path.dirname(a.path || '');
    case 'plugin:path|basename':
      return path.basename(a.path || '', a.ext || undefined);
    case 'plugin:path|extname':
      return path.extname(a.path || '');
    case 'plugin:path|is_absolute':
      return path.isAbsolute(a.path || '');
    default:
      return defaultFor(cmd);
  }
}

/** @param {import('electron').App} app */
function registerTauriHost(app) {
  // safeStorage is only reliably usable once the app is ready — registerTauriHost
  // itself is only ever called from the app.whenReady() path, so this is safe here.
  initSecretStore(app);

  // Any real quit (OS Cmd+Q / menu Quit / app_exit's app.quit()) flips the
  // isQuitting guard BEFORE the window 'close' fires, so the preventable-close
  // handler lets the quit through instead of cancelling it — otherwise Cmd+Q
  // with closeAction='minimize' would just hide the window and never quit.
  app.on('before-quit', () => {
    quitting = true;
    // No orphans: tear down every live browser WebContentsView (same
    // no-orphan intent as ptyHost's killAllPtys / mcpBridge's
    // killAllChildren, ported to this Electron-native resource type).
    closeAllBrowserViews();
    // Same no-orphan intent for the GUI-families windows (overlay/stop-button/
    // pet) + the tray icon.
    teardownGuiHost();
  });

  // Tray boot (GUI-families slice) — mirrors src-tauri/src/lib.rs's
  // `.setup(|app| {...})` tray build, which runs unconditionally at Tauri
  // startup. Called here (registerTauriHost is invoked from main.cjs's
  // app.whenReady().then(...) before createWindow()) so no main.cjs edit is
  // needed for tray creation.
  initGuiHost(app);

  ipcMain.handle('tauri:invoke', async (e, { cmd, args, body, headers } = {}) => {
    try {
      const a = args || {};
      // Secret commands (slice C) — secretDispatch owns the 7-command list;
      // it returns `undefined` for anything that isn't a secret command, so we
      // fall through. (Avoids duplicating the command list here.)
      const secretResult = secretDispatch(cmd, a);
      if (secretResult !== undefined) return secretResult;
      // fs commands (slice E) — plugin:fs|* backed by real Node fs. The raw-body
      // writes carry their bytes in `body` and path/options in `headers`, so
      // fsDispatch gets the whole payload. FS_MISS = not an fs command.
      const fsResult = fsDispatch(app, cmd, { args: a, body, headers });
      if (fsResult !== FS_MISS) return fsResult;
      // fs watch family (slice F4) — plugin:fs|watch (+ the real unwatch path,
      // plugin:resources|close) backed by real Node fs.watch. Needs `e.sender`
      // to route debounced change events back to the subscribing renderer's
      // Channel callback, so it's dispatched here (has `e` in scope) rather
      // than folded into fsDispatch (which only receives `app`).
      const fsWatchResult = fsWatchDispatch(app, cmd, { args: a, event: e });
      if (fsWatchResult !== FS_WATCH_MISS) return fsWatchResult;
      // mcp bridge (mcp 收敛) — generic stdio process bridge (mcp_spawn/write/
      // kill) the frontend uses to drive MCP servers AND the agent sidecar;
      // stdout/stderr/close re-emitted as mcp-msg/err/close-{id} events.
      // Returns undefined for non-mcp commands.
      const mcpResult = mcpDispatch(cmd, a);
      if (mcpResult !== undefined) return mcpResult;
      // Desktop-misc family (F2) — LAN IP, fullscreen, sleep prevention, OS
      // trash, clipboard, dialogs, opener, notification permission, process
      // relaunch/exit, deep-link. desktopDispatch may return a Promise
      // (trash/dialogs/opener are async) — fine, this handler is `async` and
      // just returns the value, so it resolves before reaching the caller.
      const desktopResult = desktopDispatch(app, cmd, { args: a, body, headers, event: e });
      if (desktopResult !== DESKTOP_MISS) return desktopResult;
      // Preview server (slice F13) — get_preview_server_info/register_preview_root/
      // unregister_preview_root, backed by a real loopback Node http server
      // (electron/previewServer.cjs) since the frontend hardcodes the `http://`
      // scheme (src/utils/previewUrl.ts) — placed here (after desktop, before
      // window) since it's neither a window-family nor an event-plugin command
      // and has no ordering dependency on either. previewDispatch is async
      // (server start is lazy); this handler is already `async` so awaiting is fine.
      const previewResult = await previewDispatch(app, cmd, { args: a });
      if (previewResult !== PREVIEW_MISS) return previewResult;
      // Catalog DB (slice F1b) — conversation catalog + FTS5 search, backed
      // by node:sqlite (electron/catalogDb.cjs). Synchronous under the hood;
      // returning the value directly is fine since this handler is `async`.
      const catalogResult = catalogDispatch(app, cmd, a);
      if (catalogResult !== CATALOG_MISS) return catalogResult;
      // Notice DB (slice F1b) — audit log + inbox queue, backed by
      // node:sqlite (electron/noticeDb.cjs).
      const noticeResult = noticeDispatch(app, cmd, a);
      if (noticeResult !== NOTICE_MISS) return noticeResult;
      // Command execution (slice F3) — run_shell_command/run_argv_command
      // (macOS-seatbelt-sandboxed child_process spawn, port of
      // src-tauri/src/lib.rs + sandbox.rs) + get_env_vars (whitelist-filtered
      // process.env). Placed after the sqlite dispatchers and before
      // windowDispatch — no ordering dependency on either, and commandDispatch
      // is async (spawn+wait), which this handler already awaits.
      const commandResult = await commandDispatch(app, cmd, a);
      if (commandResult !== COMMAND_MISS) return commandResult;
      // Trigger server (slice F9) — start_trigger_server/get_trigger_server_port,
      // backed by a real loopback Node http server (electron/triggerServer.cjs),
      // porting src-tauri/src/trigger_server.rs. Placed after commandDispatch
      // and before windowDispatch — no ordering dependency on either.
      const triggerResult = await triggerDispatch(app, cmd, a);
      if (triggerResult !== TRIGGER_MISS) return triggerResult;
      // Network-isolation proxy (slice F14) — start_network_proxy/
      // update_network_whitelist/get_network_proxy_port, backed by a real
      // loopback Node http server with CONNECT tunneling
      // (electron/networkProxy.cjs), porting src-tauri/src/proxy.rs. Placed
      // after triggerDispatch and before windowDispatch — no ordering
      // dependency on either.
      const networkProxyResult = await networkProxyDispatch(app, cmd, a);
      if (networkProxyResult !== NETWORK_PROXY_MISS) return networkProxyResult;
      // UI-side HTTP (plugin:http|fetch/…) — the frontend's tauriFetch routes
      // connection-verify + web/media tool fetches through this to bypass the
      // renderer CSP; returns a Promise for the http commands, HTTP_MISS else.
      const httpResult = httpDispatch(cmd, a);
      if (httpResult !== HTTP_MISS) return httpResult;
      // Computer-use / AX family (F10) — routed to the native-helper process
      // (input synthesis, screen capture, AXUIElement session cache) via
      // nativeHelperManager. Returns a Promise (resolved by the outer await) or
      // NATIVE_HELPER_MISS for anything it doesn't own.
      const nativeHelperResult = nativeHelperDispatch(cmd, a);
      if (nativeHelperResult !== NATIVE_HELPER_MISS) return nativeHelperResult;
      // Pty family (F6) — pty_spawn/pty_write/pty_resize/pty_kill, backed by
      // a real node-pty child per session (electron/ptyHost.cjs), porting
      // src-tauri/src/pty.rs for the workspace terminal tab. Placed after
      // nativeHelperDispatch and before windowDispatch — no ordering
      // dependency on either; ptyDispatch may return a Promise (pty_spawn),
      // which this already-async handler awaits via the outer `await` below.
      const ptyResult = await ptyDispatch(app, cmd, a);
      if (ptyResult !== PTY_MISS) return ptyResult;
      // Browser family (Phase 2 slice — in-app browser tab) —
      // browser_create/set_bounds/navigate/back/forward/reload/hide/show/
      // close, backed by a real `WebContentsView` per tab
      // (electron/browserHost.cjs), porting src-tauri/src/browser.rs for the
      // workspace browser tab. Placed after ptyDispatch and before
      // windowDispatch — no ordering dependency on either; browserDispatch is
      // synchronous today (WebContentsView setup/loadURL calls are all
      // fire-and-forget); if it ever returns a Promise, returning it here still
      // resolves through this async handler, so no await is needed.
      const browserResult = browserDispatch(app, cmd, a);
      if (browserResult !== BROWSER_MISS) return browserResult;
      // GUI-families (tray/overlay/window_info/pet) — electron/guiHost.cjs,
      // porting src-tauri/src/{lib.rs tray cmds, overlay.rs, window_info.rs,
      // computer_use.rs's get_abu_window_id, pet.rs}. Placed after
      // browserDispatch and before windowDispatch — no ordering dependency on
      // either; get_active_window is the only async handler in this family,
      // which this already-async ipcMain.handle callback awaits correctly.
      const guiResult = await guiDispatch(app, cmd, a);
      if (guiResult !== GUI_MISS) return guiResult;
      // Window-family commands (slice D) — checked before the event-plugin
      // switch below so plugin:window|* and app_exit/window_hide/window_show
      // never fall through to the stub. windowDispatch returns a sentinel for
      // anything it doesn't own, so non-window commands still reach dispatch().
      // `callerWin` (the REAL sending window, not necessarily `mainWindow`)
      // lets a handful of read/per-window commands act on whichever window
      // asked (e.g. the pet window reading its own position) — see
      // windowDispatch's JSDoc.
      const callerWin = BrowserWindow.fromWebContents(e.sender);
      const windowResult = windowDispatch(app, cmd, a, callerWin);
      if (windowResult !== WINDOW_DISPATCH_MISS) return windowResult;
      // Event-plugin commands need `e.sender` (the subscribing renderer's
      // WebContents) to route deliveries — handled inline rather than
      // threaded through dispatch(), which only needs `app`.
      switch (cmd) {
        case 'plugin:event|listen': {
          const id = nextEventId++;
          subscriptions.set(id, { event: a.event, callbackId: a.handler, sender: e.sender });
          return id;
        }
        case 'plugin:event|unlisten': {
          // Prune the preload's callback registry too — unlisten's synchronous
          // __TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener is a no-op (it
          // only has the eventId, not the callbackId), so without this the
          // preload `callbacks` Map would grow unbounded over a session's
          // listen/unlisten churn. Main knows the callbackId, so it tells the
          // renderer to drop it.
          const sub = subscriptions.get(a.eventId);
          if (sub && sub.sender && !sub.sender.isDestroyed()) {
            sub.sender.send('tauri:uncallback', { id: sub.callbackId });
          }
          subscriptions.delete(a.eventId);
          return null;
        }
        case 'plugin:event|emit':
          deliver(a.event, a.payload);
          return null;
        case 'plugin:event|emit_to':
          // TODO(slice D+): honor `a.target` (window/webview scoping) instead
          // of broadcasting to every subscription — fine for now, single window.
          deliver(a.event, a.payload);
          return null;
        default:
          return await dispatch(app, cmd, args);
      }
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.on('tauri:os-internals', (e) => {
    e.returnValue = osInternals(app);
  });
}

/** Distinct unknown/stubbed commands seen so far, in first-seen order. */
function getStubbedCommands() {
  return [...seenUnknownCmds];
}

module.exports = {
  registerTauriHost,
  osInternals,
  baseDir,
  dispatch,
  BaseDirectory,
  getStubbedCommands,
  emitEvent,
  clearSubscriptionsForSender,
  setMainWindow,
  getMainWindow,
  isQuitting,
  hasListeners,
  wireWindowEvents,
  requestAppExit,
};
