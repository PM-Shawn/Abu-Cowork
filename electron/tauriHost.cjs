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

const { ipcMain, nativeTheme, screen, BrowserWindow, dialog } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { abuAppDataDir, resourceRoot, REPO_ROOT } = require('./appEnv.cjs');
const { isTauriTransitionBuild } = require('./releaseMetadata.cjs');
const { initSecretStore, secretDispatch } = require('./secretStore.cjs');
const { runTauriMigration, resolveTauriAppDataDir } = require('./tauriMigration.cjs');
const {
  GET_CHANNEL: TAURI_LOCAL_STORAGE_GET,
  ACK_CHANNEL: TAURI_LOCAL_STORAGE_ACK,
  MIGRATION_VERSION: TAURI_LOCAL_STORAGE_MIGRATION_VERSION,
  prepareTauriLocalStorageMigration,
  hasLegacySourceEvidence,
  migrateWindowsSecrets,
  finalizeTauriLocalStorageMigration,
} = require('./tauriLocalStorageMigration.cjs');
const { updaterDispatch, UPDATER_MISS } = require('./updaterHost.cjs');
const { fsDispatch, FS_MISS } = require('./fsHost.cjs');
const {
  fsWatchDispatch,
  FS_WATCH_MISS,
  cleanupFsWatchesForSender,
} = require('./fsWatchHost.cjs');
const { mcpDispatch } = require('./mcpBridge.cjs');
const { SIDECAR_BRIDGE_STATE_CHANNEL } = require('./sidecarEventChannel.cjs');
const { sidecarRunRegistry } = require('./sidecarRunRegistry.cjs');
const {
  RUNTIME_EVENT_CHANNEL,
  RUNTIME_DIAGNOSTICS_CHANNEL,
  configureRuntimeObservability,
  getRuntimeDiagnostics,
  runtimeState,
} = require('./runtimeObservability.cjs');
const { desktopDispatch, DESKTOP_MISS } = require('./desktopHost.cjs');
const { popupWindowsMenu, syncMainWindowChromeTheme } = require('./windowChrome.cjs');
const {
  nativeHelperDispatch,
  NATIVE_HELPER_MISS,
  killNativeHelper,
} = require('./nativeHelperManager.cjs');
const {
  createComputerUseGate,
  COMPUTER_USE_GATE_MISS,
} = require('./computerUseGate.cjs');
const {
  buildActionApprovalDialogOptions,
} = require('./computerUseActionPolicy.cjs');
const { ptyDispatch, PTY_MISS } = require('./ptyHost.cjs');
// browserHost.cjs requires THIS module back (for emitEvent/getMainWindow),
// but only lazily (inside function bodies, called at dispatch-time, never
// at module-load-time) — so requiring it eagerly here, same as the other
// dispatch families, doesn't deadlock on the circular pair.
const { browserDispatch, BROWSER_MISS, closeAllBrowserViews } = require('./browserHost.cjs');
const {
  computerUsePermissionGuideDispatch,
  COMPUTER_USE_PERMISSION_GUIDE_MISS,
  teardownComputerUsePermissionGuide,
} = require('./computerUsePermissionGuide.cjs');
const {
  computerUsePermissionHostDispatch,
  COMPUTER_USE_PERMISSION_HOST_MISS,
} = require('./computerUsePermissionHost.cjs');
// guiHost.cjs (GUI-families slice) — same lazy-back-require pattern as
// browserHost.cjs: it needs emitEvent/getMainWindow/requestAppExit from this
// module, required lazily inside its own function bodies.
const { guiDispatch, GUI_MISS, initGuiHost, teardownGuiHost } = require('./guiHost.cjs');
const { previewDispatch, PREVIEW_MISS } = require('./previewServer.cjs');
const { catalogDispatch, CATALOG_MISS } = require('./catalogDb.cjs');
const { noticeDispatch, NOTICE_MISS } = require('./noticeDb.cjs');
const { commandDispatch, COMMAND_MISS, teardownCommandHost } = require('./commandHost.cjs');
const { triggerDispatch, TRIGGER_MISS } = require('./triggerServer.cjs');
const { networkProxyDispatch, NETWORK_PROXY_MISS } = require('./networkProxy.cjs');
const { httpDispatch, HTTP_MISS } = require('./httpHost.cjs');
const {
  globalShortcutDispatch,
  GLOBAL_SHORTCUT_MISS,
  teardownGlobalShortcuts,
  cleanupGlobalShortcutsForSender,
} = require('./globalShortcutHost.cjs');
const {
  assertTrustedIpcSender,
  validateInvokePayload,
  assertResourceOwner,
} = require('./securityBoundary.cjs');
const { wireRendererResourceCleanup } = require('./rendererLifecycle.cjs');

// Window-family state (Phase 2 slice D). `mainWindow` is set by main.cjs right
// after createWindow() via setMainWindow(); `quitting` is the standard
// isQuitting guard so app_exit's app.quit() doesn't re-trigger the
// preventable-close handler (win.on('close') in main.cjs) into an infinite
// prevent-loop.
let mainWindow = null;
let quitting = false;
let computerUseGate = null;
let migrationStartupBlock = null;
let migrationStartupPending = false;
let migrationBackupPath = null;

function setMigrationStartupBlock(reason) {
  migrationStartupBlock = String(reason || 'migration-incomplete');
  console.error(`[tauriMigration] startup blocked: ${migrationStartupBlock}`);
}

function getMigrationStartupBlock() {
  return migrationStartupBlock;
}

function isMigrationStartupPending() {
  return migrationStartupPending;
}

function showMigrationRetryDialog(app) {
  const isZh = app.getLocale().toLowerCase().startsWith('zh');
  void dialog
    .showMessageBox({
      type: 'error',
      title: isZh ? '升级数据迁移未完成' : 'Update migration incomplete',
      message: isZh
        ? 'Abu 没有写入或删除旧版数据。请重新启动后再试。'
        : 'Abu did not write to or delete the old app data. Restart the app to retry.',
      detail: isZh
        ? `为避免新框架先写入空数据，本次启动已停止。\n错误：${migrationStartupBlock}`
        : `This launch was stopped before the new framework could write empty state.\nReason: ${migrationStartupBlock}`,
      buttons: [isZh ? '退出' : 'Quit'],
      defaultId: 0,
      noLink: true,
    })
    .finally(() => app.quit());
}

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

/**
 * Flip the isQuitting guard WITHOUT initiating the quit — for callers whose
 * quit is driven elsewhere. Sole consumer today: updaterHost's
 * quitAndInstallIfPending — the native Squirrel quitAndInstall closes all
 * windows BEFORE any 'before-quit' fires, so the guard must already be set
 * or the preventable-close handler would cancel the close and the update
 * would silently never install. If that install then stalls (Squirrel fetch
 * failed), the app is left in the quitting state: the next window close
 * bypasses close-requested and really closes — an acceptable degraded mode,
 * strictly better than an unquittable app.
 */
function markQuitting() {
  quitting = true;
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
  // Purge this renderer's resources only when its top-level document is being
  // replaced. Child-frame loads (notably HTML widget `srcdoc` previews) keep
  // the renderer alive and must not disconnect its main→renderer event bridge.
  wireRendererResourceCleanup(win.webContents, ({ reason }) => {
    const subscriptionCount = clearSubscriptionsForSender(win.webContents);
    cleanupFsWatchesForSender(win.webContents);
    cleanupGlobalShortcutsForSender(win.webContents);
    computerUseGate?.revokeSender(win.webContents);
    runtimeState.noteRendererResourcesCleared({ reason, subscriptionCount });
  });
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
      // The frontend's resolveResource('sidecar/index.mjs') resolves against
      // this, then passes the path to mcp_spawn — so it MUST point where the
      // sidecar actually lives. Packaged: electron-builder puts extraResources
      // under process.resourcesPath. Dev: the repo root. (Mirrors
      // appEnv.cjs resourceRoot(app); ABU_RESOURCE_DIR is set to the same.)
      resolved = app.isPackaged ? process.resourcesPath : REPO_ROOT;
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
  let delivered = 0;
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
    delivered++;
  }
  return delivered;
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
  return deliver(event, payload);
}

/**
 * Drop every subscription owned by a given WebContents. Called on renderer
 * reload: a reload doesn't destroy the WebContents or fire unlisten, and the
 * reloaded page's preload resets its callbackId counter — so stale
 * subscriptions would cross-wire to the fresh page's colliding ids. The
 * reloaded page is gone, so there's no preload callback to notify (unlike
 * unlisten).
 * @param {import('electron').WebContents} sender
 * @returns {number} number of subscriptions removed
 */
function clearSubscriptionsForSender(sender) {
  let removed = 0;
  for (const [eventId, sub] of subscriptions) {
    if (sub.sender !== sender) continue;
    subscriptions.delete(eventId);
    removed++;
  }
  return removed;
}

// Commands whose real handler isn't wired yet (next-layer slices B-E) but
// whose callers immediately array-iterate the result (`.filter`/`.length`)
// without a defensive null-check — an empty array is both truthful (nothing
// stubbed-out can have entries yet) and keeps these boot-time consumers
// (memdir migration scan, notice inbox drain) from throwing. Named
// explicitly rather than widening the generic list/_all regex below, since
// these don't share that naming convention.
const ARRAY_RESULT_CMDS = new Set(['plugin:fs|read_dir', 'notice_inbox_pending']);

// Commands the Electron shell INTENTIONALLY does not implement (deliberate
// deferrals, NOT parity gaps): the real handler needs conditions this build
// doesn't have (a signed package, the IM line), so they degrade gracefully and
// are EXPECTED to reach the stub. Anything NOT in here that hits the stub is an
// unexpected parity gap and gets shouted about below. Keep this list in sync
// with scripts/parity-check.mjs's KNOWN_DEFERRED.
const KNOWN_DEFERRED = [
  'start_feishu_ws',
  'stop_feishu_ws',
  'get_feishu_ws_status', // F15 — feishu/IM line, deferred
];
function isKnownDeferred(cmd) {
  return KNOWN_DEFERRED.some((p) => (typeof p === 'string' ? p === cmd : p.test(cmd)));
}

function defaultFor(cmd) {
  // A stubbed command returns a shape-compatible default (see below) so the app
  // never crashes on a not-yet-wired command. The DANGER is that a genuinely
  // missing handler then fails SILENTLY (a no-op that reads as success), which
  // is exactly the hard-to-spot "点了没反应" bug. So distinguish the two:
  //  - KNOWN_DEFERRED (updater/feishu): expected — log once, quietly.
  //  - anything else: an UNEXPECTED parity gap. Be LOUD in dev (error EVERY time,
  //    not deduped) so it cannot hide; a packaged build still degrades gracefully
  //    (warn once, never throw) so a stray command can't crash a real user's app.
  //    (We log loudly rather than throw: most invoke() call sites have a .catch()
  //    that would swallow a throw, so an every-call console.error is the reliably
  //    visible signal. The durable guard is the static scripts/parity-check.mjs,
  //    which fails the build if the frontend calls a command with no handler.)
  if (isKnownDeferred(cmd)) {
    if (!seenUnknownCmds.has(cmd)) {
      seenUnknownCmds.add(cmd);
      console.log(`[tauriHost] deferred (not implemented in this build): ${cmd}`);
    }
  } else {
    let isDev = true;
    try { isDev = !require('electron').app.isPackaged; } catch { /* default to loud */ }
    if (isDev) {
      console.error(`[tauriHost] ⚠️ UNHANDLED COMMAND — parity gap, silently degrading: ${cmd}`);
    } else if (!seenUnknownCmds.has(cmd)) {
      seenUnknownCmds.add(cmd);
      console.warn(`[tauriHost] unhandled command (degraded): ${cmd}`);
    }
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
/** Windows currently in a start_dragging cursor-follow loop (re-entry guard). */
const draggingWindows = new WeakSet();

/**
 * Drag `win` by following the cursor until the mouse button is released — the
 * Electron stand-in for Tauri's native start_dragging (used by the desktop pet).
 * The cursor stays over the (small) pet window as it follows, so that window's
 * webContents reliably receives the 'mouseUp' input-event that ends the loop; a
 * 30s safety timeout covers the rare case where it doesn't. Cursor point and
 * window position are both in DIP, so no scale conversion is needed.
 * @param {import('electron').BrowserWindow} win
 */
function startWindowDrag(win) {
  if (draggingWindows.has(win) || win.isDestroyed()) return;
  draggingWindows.add(win);
  const c0 = screen.getCursorScreenPoint();
  const [wx, wy] = win.getPosition();
  const dx = c0.x - wx;
  const dy = c0.y - wy;
  const timer = setInterval(() => {
    if (win.isDestroyed()) return stop();
    const c = screen.getCursorScreenPoint();
    // Follow the cursor FREELY (no per-tick clamp): this keeps the cursor at the
    // fixed grab point over the moving window, so its mouseUp reliably ends the
    // drag. Clamping here would peg the window at a screen edge while the cursor
    // moved past it — the cursor leaves the window, the mouseUp is missed, and
    // the drag lingers (later mouse moves then reposition the pet on any click).
    // On-screen clamping happens once on release, in stop().
    win.setPosition(Math.round(c.x - dx), Math.round(c.y - dy));
  }, 16);
  const onInput = (_e, input) => {
    if (input && input.type === 'mouseUp') stop();
  };
  // A drag that somehow never sees mouseUp self-heals quickly (was 30s — too long
  // a window for the pet to be following the cursor if the release was missed).
  const safety = setTimeout(stop, 5000);
  // Also end if the window loses focus mid-drag (a defensive extra end signal).
  win.once('blur', stop);
  function stop() {
    clearInterval(timer);
    clearTimeout(safety);
    draggingWindows.delete(win);
    if (!win.isDestroyed()) {
      // Clamp back on-screen if the release left the window off the workArea, so
      // a fast drag past an edge can't strand the pet off-screen.
      const b = win.getBounds();
      const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      const nx = Math.max(wa.x, Math.min(b.x, wa.x + wa.width - b.width));
      const ny = Math.max(wa.y, Math.min(b.y, wa.y + wa.height - b.height));
      if (nx !== b.x || ny !== b.y) win.setPosition(nx, ny);
      try {
        win.webContents.removeListener('input-event', onInput);
        win.removeListener('blur', stop);
      } catch {
        /* webContents gone */
      }
    }
  }
  try {
    win.webContents.on('input-event', onInput);
  } catch {
    stop();
  }
}

function windowDispatch(app, cmd, args, callerWin) {
  const a = args || {};
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const queryWin = callerWin && !callerWin.isDestroyed() ? callerWin : win;
  switch (cmd) {
    case 'plugin:window|set_theme':
      // value is 'light'|'dark'|null/undefined (null/undefined = follow system).
      nativeTheme.themeSource = a.value === 'light' || a.value === 'dark' ? a.value : 'system';
      syncMainWindowChromeTheme(win, nativeTheme.shouldUseDarkColors);
      return null;
    case 'plugin:window|set_title':
      if (queryWin) queryWin.setTitle(String(a.title ?? ''));
      return null;
    case 'window_titlebar_menu':
      // Only the tracked main window owns the Windows custom title bar. The
      // IPC sender has already passed the privileged-page/main-frame checks in
      // registerTauriHost's handler before reaching this dispatch.
      if (process.platform !== 'win32' || !win || queryWin !== win) return false;
      return popupWindowsMenu(win, a);
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
      // Tauri's Monitor: size/position/workArea in PHYSICAL px + scaleFactor.
      // Electron's Display gives them in DIP, so scale up. IMPORTANT: @tauri-apps/
      // api's mapMonitor() reads m.workArea.position AND m.workArea.size — omitting
      // workArea makes primaryMonitor() throw "Cannot read properties of undefined
      // (reading 'position')", which rejected getPlacement() and broke the pet's
      // notification bubble + right-click menu.
      const d = screen.getPrimaryDisplay();
      const sf = d.scaleFactor || 1;
      const phys = (r) => ({
        position: { x: Math.round(r.x * sf), y: Math.round(r.y * sf) },
        size: { width: Math.round(r.width * sf), height: Math.round(r.height * sf) },
      });
      const b = phys(d.bounds);
      const wa = phys(d.workArea);
      return {
        name: null,
        size: b.size,
        position: b.position,
        workArea: wa,
        scaleFactor: sf,
      };
    }
    case 'plugin:window|start_dragging': {
      // Electron has no native "start a programmatic window drag" like Tauri's
      // start_dragging — its built-in drag is CSS -webkit-app-region (used for the
      // main window's [data-tauri-drag] top bar). The desktop pet (usePetDrag.ts)
      // is the ONLY explicit caller (verified: no other src/ caller); it expects
      // the native WM to take over the drag after a 10px threshold. Reproduce that
      // with a cursor-follow loop on the CALLER window, ending on mouseUp.
      const dragWin = callerWin || win;
      if (dragWin) startWindowDrag(dragWin);
      return null;
    }
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
function registerTauriHost(app, options = {}) {
  migrationStartupBlock = null;
  migrationStartupPending = false;
  migrationBackupPath = null;
  // safeStorage is only reliably usable once the app is ready — registerTauriHost
  // itself is only ever called from the app.whenReady() path, so this is safe here.
  initSecretStore(app);
  computerUseGate = createComputerUseGate({
    nativeDispatch: async (cmd, args) => {
      const permissionResult = await computerUsePermissionHostDispatch(cmd);
      if (permissionResult !== COMPUTER_USE_PERMISSION_HOST_MISS) {
        return permissionResult;
      }
      const result = nativeHelperDispatch(cmd, args);
      if (result === NATIVE_HELPER_MISS) {
        throw new Error(`native helper does not own Computer Use command ${cmd}`);
      }
      return await result;
    },
    getActiveWindow: async () => {
      const result = await guiDispatch(app, 'get_active_window', {});
      if (result === GUI_MISS) throw new Error('active-window provider unavailable');
      return result;
    },
    killNativeHelper,
    requestTaskApproval: async ({ target, mode }) => {
      const isZh = app.getLocale().toLowerCase().startsWith('zh');
      const modeLabel = mode === 'autonomous'
        ? (isZh ? '完全自主' : 'Full Autonomy')
        : (isZh ? '替我审批' : 'Smart Review');
      const options = {
        type: 'warning',
        title: isZh ? '允许本任务使用电脑操控？' : 'Allow Computer Use for this task?',
        message: isZh
          ? `本任务将按「${modeLabel}」模式操作已识别的普通应用`
          : `This task will use "${modeLabel}" for reviewed ordinary apps`,
        detail: isZh
          ? [
              `当前目标应用：${target.app_name}`,
              '授权仅对当前任务有效。浏览器、通讯和未知应用仍会单独询问；凭据、系统设置和终端等红线始终禁止。',
            ].join('\n')
          : [
              `Current target: ${target.app_name}`,
              'Approval applies only to this task. Browsers, communications, and unknown apps still ask separately; credential, system-settings, and terminal red lines remain blocked.',
            ].join('\n'),
        buttons: isZh ? ['允许本任务', '取消'] : ['Allow for this task', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      };
      const win = getMainWindow();
      const result = win
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options);
      return result.response === 0;
    },
    requestAppApproval: async ({ target, classification, scope, permissionMode }) => {
      const isZh = app.getLocale().toLowerCase().startsWith('zh');
      const canControl = scope === 'ui-control';
      const title = isZh
        ? (canControl
          ? `允许 Abu 操作「${target.app_name}」？`
          : '允许 Abu 查看当前屏幕？')
        : (canControl
          ? `Allow Abu to control "${target.app_name}"?`
          : 'Allow Abu to view the current screen?');
      const message = isZh
        ? (canControl
          ? 'Abu 请求查看并操作这个应用'
          : 'Abu 请求读取当前屏幕内容')
        : (canControl
          ? 'Abu wants to view and control this app'
          : 'Abu wants to view the current screen');
      const detail = isZh
        ? [
            '授权仅对当前任务有效，任务结束或 Abu 重启后自动失效。',
            classification === 'approval-required'
              ? '该应用可能包含网页、通信或其他敏感内容，或尚未被 Abu 明确识别，因此所有权限模式都需要你确认。'
              : `当前权限模式为「${permissionMode}」，首次操作此应用需要你确认。`,
          ].join('\n')
        : [
            'This permission only applies to the current task and expires when the task ends or Abu restarts.',
            classification === 'approval-required'
              ? 'This app may contain web, communication, or other sensitive content, or is not yet explicitly recognized by Abu, so every permission mode requires confirmation.'
              : `The current permission mode is "${permissionMode}", so first use of this app needs confirmation.`,
          ].join('\n');
      const options = {
        type: 'warning',
        title,
        message,
        detail,
        buttons: isZh ? ['允许本任务', '取消'] : ['Allow for this task', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      };
      const win = getMainWindow();
      const result = win
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options);
      return result.response === 0;
    },
    requestActionApproval: async ({ target, consequence }) => {
      const isZh = app.getLocale().toLowerCase().startsWith('zh');
      const options = buildActionApprovalDialogOptions({
        isZh,
        target,
        consequence,
      });
      const win = getMainWindow();
      const result = win
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options);
      return result.response === 0;
    },
  });

  // One-time Tauri→Electron migration. It is armed only by packaged release
  // metadata (or an explicit dev test env), never merely by appId/path. This
  // keeps local and PR packages away from installed user data.
  //
  // LocalStorage is prepared first because Windows Credential Manager keys
  // include custom provider/backend ids stored in abu-settings. The reader
  // opens only a temporary copy of WebView2 LevelDB. During the framework
  // transition the installed Tauri source wins shared keys; prior Electron
  // values are backed up, the source is never modified, and any failure leaves
  // the sentinel absent for a retry.
  // Runs AFTER initSecretStore (it stores decrypted keys through the secret
  // commands) and never throws — a migration failure must not block boot.
  // The file copy is synchronous before the main window exists so the frontend
  // cannot race it by creating empty state. main.cjs keeps a sandboxed,
  // non-persistent progress window visible during this bounded first boot.
  const migrateEnv = process.env.ABU_MIGRATE_FROM_TAURI;
  const migrationArmed = isTauriTransitionBuild(app);
  const migrationDiagnosticsPath =
    process.env.ABU_E2E_MIGRATION_DIAGNOSTICS_PATH;
  const writeMigrationDiagnostics = (record) => {
    if (
      process.env.CI !== 'true' ||
      process.env.ABU_PACKAGED_E2E !== '1' ||
      typeof migrationDiagnosticsPath !== 'string' ||
      !path.isAbsolute(migrationDiagnosticsPath)
    ) {
      return;
    }
    try {
      fs.mkdirSync(path.dirname(migrationDiagnosticsPath), { recursive: true });
      fs.writeFileSync(
        migrationDiagnosticsPath,
        JSON.stringify(record, null, 2),
        'utf8'
      );
    } catch (error) {
      console.warn(
        `[tauriMigration] could not write CI diagnostics: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  };
  const migrationPaths = {
    appData: app.getPath('appData'),
    tauriDir: resolveTauriAppDataDir(app.getPath('appData'), app.isPackaged),
    electronDir: abuAppDataDir(app),
  };
  writeMigrationDiagnostics({
    stage: 'metadata',
    migrationArmed,
    migrateEnv: migrateEnv || null,
    isPackaged: app.isPackaged,
    paths: migrationPaths,
  });
  let localStorageMigration = null;
  let fileMigrationResult = null;
  if (migrationArmed || migrateEnv === '1' || migrateEnv === 'dry') {
    const readerName = process.platform === 'win32'
      ? 'tauri-transition-reader.exe'
      : 'tauri-transition-reader';
    const readerPath = path.join(resourceRoot(app), 'native-helper', readerName);
    try {
      localStorageMigration = prepareTauriLocalStorageMigration({
        electronDir: abuAppDataDir(app),
        storageRoot: options.tauriStorageRoot || undefined,
        readerPath,
        dryRun: migrateEnv === 'dry',
      });
      const itemCount = Array.isArray(localStorageMigration.items)
        ? localStorageMigration.items.length
        : 0;
      console.log(
        `[tauriLocalStorageMigration] ${localStorageMigration.status}; ${itemCount} item(s)`
      );
      if (migrationArmed && localStorageMigration.status === 'error') {
        setMigrationStartupBlock(localStorageMigration.reason);
      }
      migrationStartupPending =
        migrationArmed && localStorageMigration.status === 'pending';
    } catch (err) {
      if (migrationArmed) {
        setMigrationStartupBlock(
          `local-storage-preparation-failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
      console.warn(
        `[tauriLocalStorageMigration] preparation failed (continuing boot): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    try {
      const result = runTauriMigration({
        tauriDir: migrationPaths.tauriDir,
        electronDir: migrationPaths.electronDir,
        secretSet: (key, value) => secretDispatch('secret_set', { key, value }),
        secretHas: (key) => secretDispatch('secret_has', { key }) === true,
        dryRun: migrateEnv === 'dry',
        sourceWins: migrationArmed || migrateEnv === '1',
        inventory: options.transitionInventory,
      });
      fileMigrationResult = result;
      writeMigrationDiagnostics({
        stage: 'file-migration',
        migrationArmed,
        migrateEnv: migrateEnv || null,
        isPackaged: app.isPackaged,
        paths: migrationPaths,
        localStorage: localStorageMigration
          ? {
              status: localStorageMigration.status,
              reason: localStorageMigration.reason || null,
              sourceDatabase: localStorageMigration.sourceDatabase || null,
              sourceFingerprint:
                localStorageMigration.sourceFingerprint || null,
            }
          : null,
        result,
      });
      if ('skipped' in result) {
        console.log(`[tauriMigration] skipped: ${result.skipped}`);
      } else if (
        migrationArmed &&
        migrateEnv !== 'dry' &&
        result.sentinelWritten !== true
      ) {
        setMigrationStartupBlock('file-or-secret-migration-incomplete');
      }
      if (typeof result.backup?.path === 'string') {
        migrationBackupPath = result.backup.path;
      }
      if (localStorageMigration && migrationBackupPath) {
        localStorageMigration.backupPath = migrationBackupPath;
      }
    } catch (err) {
      if (migrationArmed) {
        setMigrationStartupBlock(
          `file-migration-failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      console.warn(
        `[tauriMigration] migration failed (continuing boot): ${err instanceof Error ? err.message : String(err)}`
      );
    }
    // Windows secrets are read only after the Electron encrypted store has
    // been copied into the recovery backup above. The installed Tauri profile
    // is authoritative for a transition build; same-key RC/test secrets are
    // replaced, while the encrypted pre-migration store remains recoverable.
    if (
      process.platform === 'win32' &&
      localStorageMigration &&
      ['pending', 'dry-run'].includes(localStorageMigration.status)
    ) {
      const secrets = migrateWindowsSecrets(localStorageMigration, {
        readerPath,
        secretSet: (key, value) => secretDispatch('secret_set', { key, value }),
        secretHas: (key) => secretDispatch('secret_has', { key }) === true,
        sourceWins: migrationArmed || migrateEnv === '1',
        hasLegacySource: hasLegacySourceEvidence(
          localStorageMigration,
          fileMigrationResult
        ),
      });
      console.log(
        `[tauriLocalStorageMigration] Windows secrets: ${secrets.migrated.length} migrated, ` +
          `${secrets.overwritten.length} overwritten from installed Tauri, ` +
          `${secrets.skippedExisting.length} existing, ${secrets.missing.length} absent, ` +
          `${secrets.failed.length} failed` +
          (secrets.skippedReason ? `; skipped: ${secrets.skippedReason}` : '')
      );
      if (migrationArmed && localStorageMigration.secretMigrationFailed) {
        setMigrationStartupBlock('windows-secret-migration-failed');
      }
    }
  }

  ipcMain.on(TAURI_LOCAL_STORAGE_GET, (e) => {
    try {
      assertTrustedIpcSender(e);
      e.returnValue =
        localStorageMigration?.status === 'pending'
          ? {
              version: TAURI_LOCAL_STORAGE_MIGRATION_VERSION,
              items: localStorageMigration.items,
              conflictPolicy: localStorageMigration.conflictPolicy,
            }
          : null;
    } catch {
      e.returnValue = null;
    }
  });
  ipcMain.on(TAURI_LOCAL_STORAGE_ACK, (e, acknowledgement) => {
    try {
      assertTrustedIpcSender(e);
      const result = finalizeTauriLocalStorageMigration(
        localStorageMigration,
        acknowledgement
      );
      migrationStartupPending = false;
      e.returnValue = result;
      if (migrationArmed && result?.ok !== true && result?.retry === true) {
        setMigrationStartupBlock(result.reason);
        if (!e.sender.isDestroyed()) e.sender.stop();
        setImmediate(() => {
          showMigrationRetryDialog(app);
        });
      }
    } catch (err) {
      migrationStartupPending = false;
      e.returnValue = {
        ok: false,
        retry: true,
        reason: err instanceof Error ? err.message : String(err),
      };
      if (migrationArmed) {
        setMigrationStartupBlock(e.returnValue.reason);
        if (!e.sender.isDestroyed()) e.sender.stop();
        setImmediate(() => {
          showMigrationRetryDialog(app);
        });
      }
    }
  });

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
    // The permission coach is a separate always-on-top utility window. Close
    // and settle any pending setup request before the native helper is killed.
    teardownComputerUsePermissionGuide();
    // Same no-orphan intent for OS-level global-hotkey bindings — globalShortcut
    // registrations are a process-wide OS resource that outlives a destroyed
    // BrowserWindow, so they must be explicitly released on quit.
    teardownGlobalShortcuts();
    // Same no-orphan intent for command trees. Background commands keep their
    // 3s-return behavior, but the registry still owns them for app shutdown.
    teardownCommandHost();
    computerUseGate?.teardown();
  });

  // Tray boot (GUI-families slice) — mirrors src-tauri/src/lib.rs's
  // `.setup(|app| {...})` tray build, which runs unconditionally at Tauri
  // startup. Called here (registerTauriHost is invoked from main.cjs's
  // app.whenReady().then(...) before createWindow()) so no main.cjs edit is
  // needed for tray creation.
  initGuiHost(app);

  ipcMain.handle('tauri:invoke', async (e, payload) => {
    try {
      const senderRecord = assertTrustedIpcSender(e);
      const { cmd, args, body, headers } = validateInvokePayload(senderRecord, payload);
      const a = args;
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
      // Updater family (F-slice #2) — plugin:updater|check/download_and_install
      // bridged onto electron-updater (generic provider → existing OSS bucket).
      // Needs `e.sender` for the download-progress Channel, so dispatched here.
      const updaterResult = updaterDispatch(cmd, { args: a, event: e });
      if (updaterResult !== UPDATER_MISS) return updaterResult;
      // mcp bridge (mcp 收敛) — generic stdio process bridge (mcp_spawn/write/
      // kill) the frontend uses to drive MCP servers AND the agent sidecar;
      // stdout/stderr/close re-emitted as mcp-msg/err/close-{id} events.
      // Returns undefined for non-mcp commands.
      const mcpResult = mcpDispatch(app, cmd, a);
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
      const computerUseResult = await computerUseGate.dispatch(senderRecord, e.sender, cmd, a);
      if (computerUseResult !== COMPUTER_USE_GATE_MISS) return computerUseResult;
      // Computer Use permission onboarding is a separate Electron-owned
      // utility window. The show command intentionally remains pending until
      // the user completes or cancels setup, while close can arrive through a
      // concurrent renderer IPC call during task cancellation/unmount.
      const permissionGuideResult =
        await computerUsePermissionGuideDispatch(app, cmd, a);
      if (permissionGuideResult !== COMPUTER_USE_PERMISSION_GUIDE_MISS) {
        return permissionGuideResult;
      }
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
      // Global-shortcut plugin — plugin:global-shortcut|register/unregister/
      // unregister_all/is_registered (the computer-use abort hotkey,
      // src/core/agent/computerUseStatus.ts), backed by Electron's
      // `globalShortcut` module (electron/globalShortcutHost.cjs). Needs `e`
      // (to route delivery to the registering renderer's Channel callback —
      // same reason fsWatchDispatch needs it), so it's dispatched here rather
      // than folded into dispatch(). Placed after guiDispatch and before
      // windowDispatch — no ordering dependency on either.
      const globalShortcutResult = globalShortcutDispatch(cmd, { args: a, event: e });
      if (globalShortcutResult !== GLOBAL_SHORTCUT_MISS) return globalShortcutResult;
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
          // A renderer just subscribed. If it's the deep-link channel, drain any
          // running-app deep links that arrived before the subscriber existed
          // (the OS can deliver open-url / second-instance URLs before React
          // mounts useDeepLinkEnroll). Precise flush-on-subscribe — matching how
          // WorkBuddy/Codex queue then flush at a known-ready moment rather than
          // blind-send. Lazy require avoids a load-order cycle with deepLinkHost.
          if (a.event === 'deep-link://new-url') {
            try {
              require('./deepLinkHost.cjs').flushPendingDeepLinks();
            } catch {
              /* deepLinkHost not wired (e.g. a harness) — nothing to flush */
            }
          }
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
          assertResourceOwner(sub, e.sender, 'event subscription');
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
    try {
      assertTrustedIpcSender(e);
      e.returnValue = osInternals(app);
    } catch {
      e.returnValue = null;
    }
  });

  ipcMain.on(RUNTIME_EVENT_CHANNEL, (e, payload) => {
    try {
      assertTrustedIpcSender(e);
      configureRuntimeObservability(app);
      runtimeState.noteRendererEvent(payload);
    } catch {
      // Runtime tracing is best-effort and must never affect product behavior.
    }
  });

  ipcMain.handle(RUNTIME_DIAGNOSTICS_CHANNEL, async (e) => {
    assertTrustedIpcSender(e);
    configureRuntimeObservability(app);
    return getRuntimeDiagnostics();
  });

  ipcMain.handle(SIDECAR_BRIDGE_STATE_CHANNEL, async (e, query = {}) => {
    assertTrustedIpcSender(e);
    const afterSequence = Number.isSafeInteger(query?.afterSequence) && query.afterSequence >= 0
      ? query.afterSequence
      : 0;
    return sidecarRunRegistry.snapshot(afterSequence);
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
  markQuitting,
  getMigrationStartupBlock,
  isMigrationStartupPending,
  getMigrationBackupPath: () => migrationBackupPath,
  hasListeners,
  wireWindowEvents,
  requestAppExit,
};
