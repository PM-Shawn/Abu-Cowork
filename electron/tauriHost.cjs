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
 * back to renderer-registered callbacks via `emitEvent()`. Everything else
 * falls back to a benign stub (mirrors electron/spike/tauriShimPreload.cjs's
 * defaultFor pattern) so the frontend can boot past this layer — later
 * slices (C-E) replace individual stubs with real handlers.
 *
 * Wired from electron/main.cjs via registerTauriHost(app) BEFORE the
 * BrowserWindow is created (the preload's synchronous os-internals fetch
 * needs the 'tauri:os-internals' handler registered first).
 */
'use strict';

const { ipcMain } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { abuAppDataDir } = require('./appEnv.cjs');

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
 * @param {string} event
 * @param {unknown} payload
 */
function emitEvent(event, payload) {
  deliver(event, payload);
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
  ipcMain.handle('tauri:invoke', async (e, { cmd, args } = {}) => {
    try {
      const a = args || {};
      // Event-plugin commands need `e.sender` (the subscribing renderer's
      // WebContents) to route deliveries — handled inline rather than
      // threaded through dispatch(), which only needs `app`.
      switch (cmd) {
        case 'plugin:event|listen': {
          const id = nextEventId++;
          subscriptions.set(id, { event: a.event, callbackId: a.handler, sender: e.sender });
          return id;
        }
        case 'plugin:event|unlisten':
          subscriptions.delete(a.eventId);
          return null;
        case 'plugin:event|emit':
          deliver(a.event, a.payload);
          return null;
        case 'plugin:event|emit_to':
          // TODO(slice C+): honor `a.target` (window/webview scoping) instead
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

module.exports = { registerTauriHost, osInternals, baseDir, dispatch, BaseDirectory, getStubbedCommands, emitEvent };
