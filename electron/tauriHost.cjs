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

const { ipcMain, nativeTheme } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { abuAppDataDir } = require('./appEnv.cjs');
const { initSecretStore, secretDispatch } = require('./secretStore.cjs');

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

function isQuitting() {
  return quitting;
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
      resolved = process.resourcesPath;
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
 */
function windowDispatch(app, cmd, args) {
  const a = args || {};
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  switch (cmd) {
    case 'plugin:window|set_theme':
      // value is 'light'|'dark'|null/undefined (null/undefined = follow system).
      nativeTheme.themeSource = a.value === 'light' || a.value === 'dark' ? a.value : 'system';
      return null;
    case 'plugin:window|set_title':
      if (win) win.setTitle(String(a.title ?? ''));
      return null;
    case 'plugin:window|is_focused':
      return win ? win.isFocused() : false;
    case 'plugin:window|set_badge_count':
      // macOS dock badge only; Windows/Linux have no equivalent in Electron's
      // cross-platform API (Windows would need setOverlayIcon per-window).
      app.setBadgeCount(Number(a.count) || 0);
      return null;
    case 'plugin:window|outer_position': {
      if (!win) return { x: 0, y: 0 };
      const [x, y] = win.getPosition();
      return { x, y };
    }
    case 'plugin:window|start_dragging':
      // Electron drags windows via CSS `-webkit-app-region: drag`, not an IPC
      // call — no-op here.
      return null;
    case 'plugin:window|close':
      if (win) win.close(); // routes through the preventable-close handler in main.cjs
      return null;
    case 'app_exit':
      // Standard isQuitting guard: flip BEFORE app.quit() so the close
      // handler's `if (isQuitting()) return;` lets this quit proceed instead
      // of preventing it again (which would otherwise infinite-loop).
      quitting = true;
      app.quit();
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

  ipcMain.handle('tauri:invoke', async (e, { cmd, args } = {}) => {
    try {
      const a = args || {};
      // Secret commands (slice C) — secretDispatch owns the 7-command list;
      // it returns `undefined` for anything that isn't a secret command, so we
      // fall through. (Avoids duplicating the command list here.)
      const secretResult = secretDispatch(cmd, a);
      if (secretResult !== undefined) return secretResult;
      // Window-family commands (slice D) — checked before the event-plugin
      // switch below so plugin:window|* and app_exit/window_hide/window_show
      // never fall through to the stub. windowDispatch returns a sentinel for
      // anything it doesn't own, so non-window commands still reach dispatch().
      const windowResult = windowDispatch(app, cmd, a);
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
  isQuitting,
};
