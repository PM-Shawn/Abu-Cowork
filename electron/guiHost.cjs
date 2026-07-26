/**
 * Electron main-side GUI window/tray host (Phase 2 GUI-families slice) —
 * ports the remaining Tauri window/tray families that aren't the main
 * window itself: the system tray, the Computer-Use screen-border overlay +
 * stop button, active/own-window info, and the desktop pet.
 *
 * Exports `guiDispatch(app, cmd, args)` + `GUI_MISS`, wired into
 * electron/tauriHost.cjs's dispatch chain (after browserDispatch — see the
 * wiring comment there). Also exports `initGuiHost(app)` (creates the tray
 * at startup, mirroring src-tauri/src/lib.rs's `.setup(|app| {...})` tray
 * build — called from tauriHost.cjs's `registerTauriHost(app)`, so no
 * main.cjs edit is needed for tray boot) and `teardownGuiHost()` (destroys
 * every window this module owns — called from tauriHost.cjs's
 * `before-quit` handler, same no-orphan-window intent as
 * browserHost.cjs's `closeAllBrowserViews()`).
 *
 * ## Families ported here (command → Rust source verified against)
 * 1. **Tray**: `update_tray_menu {imChannels, triggerCount}` (camelCase —
 *    src/core/im/traySync.ts:43 sends `{imChannels, triggerCount}`; Tauri
 *    auto-cased those to the Rust params `im_channels`/`trigger_count`,
 *    Electron's raw IPC does not, so this reads the camelCase keys
 *    directly) + `update_tray_notice_count {count}`
 *    (src/stores/noticeMenubarStore.ts:61) — src-tauri/src/lib.rs:1191-1262
 *    (`update_tray_menu`/`update_tray_notice_count`) + lib.rs:1349-1380 (tray
 *    build in `.setup()`).
 * 2. **Overlay**: `show_screen_border {stopLabel}`, `hide_screen_border`,
 *    `get_overlay_window_id` — src-tauri/src/overlay.rs. Two windows (the
 *    click-through border + the clickable stop button), same as Rust.
 * 3. **window_info**: `get_active_window` — src-tauri/src/window_info.rs
 *    (osascript/PowerShell ported verbatim via child_process for parity) +
 *    `get_abu_window_id` — src-tauri/src/computer_use.rs:126-149.
 * 4. **Pet**: `pet_show`/`pet_hide`/`pet_focus_main`/`pet_set_frame` —
 *    src-tauri/src/pet.rs. Real wiring: `pet.html` is a genuine separate
 *    Vite build entry (vite.config.ts `rollupOptions.input.pet`, already
 *    present in `dist-electron-spike/pet.html`) that renders ONLY
 *    `src/pet/PetApp.tsx` via `src/pet/main.tsx` — no window-label routing
 *    to reverse-engineer, so this loads that real bundle, not a placeholder.
 *
 * ## Cross-window IPC target ("caller-aware" window resolution)
 * The pet window uses the FULL production preload (same as main — it's a
 * real bundled React entry using `@tauri-apps/api`), which hardcodes
 * `metadata.currentWindow.label = 'main'` (see preload.cjs) — so
 * `getCurrentWindow()` calls from inside the pet window are
 * mislabeled, but that's harmless UNLESS a generic `plugin:window|*` command
 * needs to act on "whichever window is actually calling" rather than
 * always the tracked main window. `PetApp.tsx`'s `getPlacement()` calls
 * `getCurrentWindow().outerPosition()` to read the PET window's own screen
 * position — routed through tauriHost.cjs's `windowDispatch`, which this
 * port therefore made caller-aware (resolves the real calling
 * `BrowserWindow` via `BrowserWindow.fromWebContents(e.sender)` for the
 * read/per-window state commands only — see tauriHost.cjs) so this
 * resolves to the pet window, not main. `pet_set_frame`/`pet_focus_main`
 * are custom commands (not the generic window plugin) and are handled
 * entirely in this file against the tracked `petWindow`/main window, so
 * they're unaffected by that mislabeling either way.
 *
 * The overlay/stop-button windows are plain unbundled static HTML (no
 * `@tauri-apps/api`, no module preload) — they get their OWN minimal
 * preload (guiTauriGlobalPreload.cjs) shimming just `window.__TAURI__.
 * event.{listen,emit}`, which is all they call.
 */
'use strict';

const { Tray, Menu, BrowserWindow, screen, nativeImage, app: electronApp } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { REPO_ROOT } = require('./appEnv.cjs');

const GUI_MISS = Symbol('gui-dispatch-miss');

// Lazy-required (not at top-level) — same circular-require pattern as
// browserHost.cjs: tauriHost.cjs requires THIS module (to wire guiDispatch
// into its command switch, and initGuiHost/teardownGuiHost into its own
// lifecycle), and this module needs tauriHost's emitEvent/getMainWindow.
let _tauriHost = null;
function tauriHost() {
  if (!_tauriHost) _tauriHost = require('./tauriHost.cjs');
  return _tauriHost;
}
function mainWin() {
  return tauriHost().getMainWindow();
}

/** Frontend-built asset, falling back to the unbundled `public/` source (dev-only parity with main.cjs's own FRONTEND_INDEX/placeholder fallback). */
function resolveHtml(name, publicFallback) {
  const built = path.join(REPO_ROOT, 'dist-electron-spike', name);
  if (fs.existsSync(built)) return built;
  const fallback = path.join(REPO_ROOT, publicFallback ?? path.join('public', name));
  if (!fs.existsSync(fallback)) {
    console.warn(`[guiHost] neither ${built} nor ${fallback} exist — window will fail to load`);
  }
  return fallback;
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Tray — port of lib.rs's tray build (`.setup()`) + update_tray_menu +
//    update_tray_notice_count.
// ─────────────────────────────────────────────────────────────────────────

/** @type {import('electron').Tray | null} */
let tray = null;

/** Reuse the regular app icon, same as Tauri (`app.default_window_icon()`) — not a template/monochrome asset, just downscaled into the tray slot. */
function resolveTrayIconPath() {
  // Packaged: src-tauri/ is not packed into app.asar — the icons ship via
  // extraResources to Resources/icons instead (same gated-on-isPackaged
  // pattern as appEnv/nativeHelper resource paths).
  const iconDir = electronApp.isPackaged
    ? path.join(process.resourcesPath, 'icons')
    : path.join(REPO_ROOT, 'src-tauri', 'icons');
  const candidates = ['32x32.png', '128x128.png', '512x512.png'].map((f) => path.join(iconDir, f));
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/** Show + focus + unminimize the main window (port of lib.rs's `show_main_window`). */
function showMainWindowFromTray() {
  const win = mainWin();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (process.platform === 'darwin' && electronApp.dock) {
    try {
      electronApp.dock.show();
    } catch {
      /* best-effort */
    }
  }
}

/** Build the tray's context menu from the current IM/trigger state — shared by createTray() (initial "Show/Quit only" state) and updateTrayMenu(). */
function buildTrayMenu(imChannels, triggerCount) {
  /** @type {import('electron').MenuItemConstructorOptions[]} */
  const template = [];
  if (imChannels && imChannels.length > 0) {
    template.push({ label: '── IM ──', enabled: false });
    for (const ch of imChannels) {
      template.push({ label: `  ${ch.label} · ${ch.sessions} sessions`, enabled: false });
    }
  }
  if (triggerCount > 0) {
    template.push({ label: `⚡ ${triggerCount} triggers active`, enabled: false });
  }
  if (template.length > 0) template.push({ type: 'separator' });
  template.push({ label: 'Show Abu / 显示窗口', click: showMainWindowFromTray });
  template.push({
    label: 'Quit / 退出',
    click: () => tauriHost().requestAppExit(electronApp),
  });
  return Menu.buildFromTemplate(template);
}

/** Create the tray icon at app startup (called from registerTauriHost — no main.cjs edit needed, mirrors Rust's `.setup()` timing). Idempotent. */
function createTray() {
  if (tray) return tray;
  const iconPath = resolveTrayIconPath();
  let image = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  // Diagnostic (WorkBuddy #32637 pattern): an empty image here means the icon
  // path resolved but nativeImage couldn't decode it (or no candidate existed)
  // — the tray would show blank. Log the path so a cold-launch "invisible tray"
  // can be told apart from a draw-timing issue.
  if (image.isEmpty()) {
    console.warn('[guiHost] tray icon image is empty — tray may render blank', { iconPath });
  }
  if (process.platform === 'darwin' && !image.isEmpty()) {
    image = image.resize({ width: 18, height: 18 }); // macOS menu-bar icon size
  }
  tray = new Tray(image);
  tray.setToolTip('Abu');
  tray.setContextMenu(buildTrayMenu([], 0));
  // Rust: `show_menu_on_left_click(false)` + a manual `on_tray_icon_event` for
  // Left+Up → show_main_window (right-click still pops the menu via Tauri's
  // default). Electron's parity here: do NOT rely on setContextMenu's
  // automatic click-shows-menu (that would show it on left-click too, unlike
  // Rust) — instead handle 'click' (left) as reopen and 'right-click' as the
  // explicit menu popup.
  tray.on('click', showMainWindowFromTray);
  tray.on('right-click', () => tray && tray.popUpContextMenu());
  return tray;
}

/** `update_tray_menu {imChannels, triggerCount}` — src-tauri/src/lib.rs:1191. */
function updateTrayMenu(args) {
  const t = tray || createTray();
  const imChannels = Array.isArray(args.imChannels) ? args.imChannels : [];
  const triggerCount = Number(args.triggerCount) || 0;
  t.setContextMenu(buildTrayMenu(imChannels, triggerCount));
  return null;
}

/** `update_tray_notice_count {count}` — src-tauri/src/lib.rs:1242. macOS-only text (Tray.setTitle is macOS-only in Electron too, same limitation as Rust's tray.set_title). */
function updateTrayNoticeCount(args) {
  const t = tray || createTray();
  const count = Number(args.count) || 0;
  if (process.platform === 'darwin') {
    t.setTitle(count > 0 ? String(count) : '');
  }
  t.setToolTip(count > 0 ? `Abu — ${count} pending` : 'Abu');
  return null;
}

function destroyTray() {
  if (tray) {
    try {
      tray.destroy();
    } catch {
      /* best-effort */
    }
    tray = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 2. Overlay — port of src-tauri/src/overlay.rs. Two windows: a click-through
//    full-screen border + a clickable stop button, both loading Abu's own
//    static HTML (public/overlay.html, public/stop-button.html) via the
//    minimal `window.__TAURI__` preload (guiTauriGlobalPreload.cjs).
// ─────────────────────────────────────────────────────────────────────────

/** @type {import('electron').BrowserWindow | null} */
let overlayWindow = null;
/** @type {import('electron').BrowserWindow | null} */
let stopBtnWindow = null;

const STOP_BTN_WIDTH = 160;
const STOP_BTN_HEIGHT = 40;

const GUI_PRELOAD = path.join(__dirname, 'guiTauriGlobalPreload.cjs');

/** Common no-chrome/always-on-top/all-Spaces window options shared by overlay + stop-button + pet — port of the NSWindow tweaks in overlay.rs/pet.rs, expressed via Electron's cross-platform BrowserWindow options where possible. */
function baseFloatingWindowOptions(extra) {
  return {
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    // NOT minimizable: overlay / stop-button are always-on-top "AI is operating
    // the computer" indicators — the agent's own meta+m / minimize-all must not
    // shrink them away (they were getting minimized along with the app windows).
    minimizable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: GUI_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    ...extra,
  };
}

/** Apply macOS "join every Space, stay stationary" collection behavior — port of the `NSWindowCollectionBehavior::CanJoinAllSpaces | Stationary` calls in overlay.rs/pet.rs. */
function applyAllSpaces(win) {
  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch {
    /* best-effort — non-macOS or unsupported */
  }
}

/** `show()` on 'ready-to-show' (avoids a white flash), with a timeout fallback in case that event never fires (e.g. a renderer-side error before first paint) so the window doesn't stay hidden forever. */
function showWhenReady(win, timeoutMs = 1500) {
  let shown = false;
  const doShow = () => {
    if (shown || !win || win.isDestroyed()) return;
    shown = true;
    win.show();
  };
  win.once('ready-to-show', doShow);
  setTimeout(doShow, timeoutMs);
}

function showOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.show();
    return;
  }
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.bounds; // Electron bounds are already logical/DIP — no scale-factor math needed (unlike Tauri's monitor.size()/position(), which are physical pixels)
  overlayWindow = new BrowserWindow(
    baseFloatingWindowOptions({
      x,
      y,
      width,
      height,
      focusable: false, // click-through AND never takes focus — matches Rust's setIgnoresMouseEvents + focused(false)
      alwaysOnTop: true,
    })
  );
  overlayWindow.setIgnoreMouseEvents(true);
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  applyAllSpaces(overlayWindow);
  void overlayWindow.loadFile(resolveHtml('overlay.html'));
  showWhenReady(overlayWindow);
}

function showStopButton(stopLabel) {
  if (stopBtnWindow && !stopBtnWindow.isDestroyed()) {
    stopBtnWindow.show();
    return;
  }
  const display = screen.getPrimaryDisplay();
  const x = Math.round(display.bounds.x + (display.bounds.width - STOP_BTN_WIDTH) / 2);
  const y = display.bounds.y + 8;
  stopBtnWindow = new BrowserWindow(
    baseFloatingWindowOptions({
      x,
      y,
      width: STOP_BTN_WIDTH,
      height: STOP_BTN_HEIGHT,
      focusable: true, // must be clickable, unlike the overlay
      alwaysOnTop: true,
    })
  );
  // Higher level than the overlay so it's always visible/clickable above it
  // (Rust: NSStatusWindowLevel+2 vs overlay's +1) — Electron's relativeLevel
  // 3rd arg stacks atop the named level.
  stopBtnWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  applyAllSpaces(stopBtnWindow);
  // stop-button.html reads `window.__CU_I18N__.stopControl` from its own
  // trailing (synchronous, non-deferred) inline <script> block — which runs
  // DURING parsing, before `did-finish-load`/`dom-ready` ever fire, so there
  // is no post-load injection hook that would win that race. Instead the
  // label travels in via the loaded URL's query string, read by
  // guiTauriGlobalPreload.cjs (which runs before ANY page script, same
  // timing guarantee as Tauri's `initialization_script`) and exposed as
  // `window.__CU_I18N__` via contextBridge before the page's own script runs.
  void stopBtnWindow.loadFile(resolveHtml('stop-button.html'), { query: { stopLabel: stopLabel ?? '' } });
  showWhenReady(stopBtnWindow);
}

/** `show_screen_border {stopLabel}` — overlay.rs:21. */
function showScreenBorder(args) {
  showOverlay();
  showStopButton(String(args.stopLabel ?? ''));
  return null;
}

/** `hide_screen_border` — overlay.rs:29 (Rust hide()s then destroy()s both; recreated fresh next `show_screen_border`, matching Rust's not-cached-across-hide semantics). */
function hideScreenBorder() {
  // Rust: hide() then destroy() (not a plain close(), which dispatches the
  // normal close lifecycle) — destroy() is the immediate, undeferred
  // teardown, matching that exactly.
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.hide();
    overlayWindow.destroy();
  }
  overlayWindow = null;
  if (stopBtnWindow && !stopBtnWindow.isDestroyed()) {
    stopBtnWindow.hide();
    stopBtnWindow.destroy();
  }
  stopBtnWindow = null;
  return null;
}

/** Parse the numeric window id out of Electron's `getMediaSourceId()` ("window:<id>:0"). On macOS that numeric id IS the CGWindowID (same numbering space as the Rust side's `NSWindow.windowNumber()`) — see report for the verification caveat. */
function parseMediaSourceWindowId(win) {
  if (!win || win.isDestroyed()) return null;
  const sourceId = win.getMediaSourceId();
  const m = /^window:(\d+):/.exec(sourceId || '');
  return m ? Number(m[1]) : null;
}

/** `get_overlay_window_id` — overlay.rs:43 (Rust prefers the stop-button window since it's higher z-order, so excluding it also excludes the overlay below it — same preference order here). */
function getOverlayWindowId() {
  const win =
    stopBtnWindow && !stopBtnWindow.isDestroyed()
      ? stopBtnWindow
      : overlayWindow && !overlayWindow.isDestroyed()
        ? overlayWindow
        : null;
  return win ? parseMediaSourceWindowId(win) : null;
}

function destroyOverlayWindows() {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
  overlayWindow = null;
  if (stopBtnWindow && !stopBtnWindow.isDestroyed()) stopBtnWindow.destroy();
  stopBtnWindow = null;
}

// ─────────────────────────────────────────────────────────────────────────
// 3. window_info — src-tauri/src/window_info.rs (`get_active_window`) +
//    src-tauri/src/computer_use.rs:126 (`get_abu_window_id`).
// ─────────────────────────────────────────────────────────────────────────

/** osascript AppleScript, verbatim port of window_info.rs's macOS branch. */
const MACOS_ACTIVE_WINDOW_SCRIPT = `
        tell application "System Events"
            set frontApp to first application process whose frontmost is true
            set appName to name of frontApp
            set bundleId to bundle identifier of frontApp
            try
                set winTitle to name of front window of frontApp
            on error
                set winTitle to ""
            end try
        end tell
        return appName & "|||" & winTitle & "|||" & bundleId
    `;

/** PowerShell script, verbatim port of window_info.rs's Windows branch. */
const WINDOWS_ACTIVE_WINDOW_SCRIPT = `
        Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        using System.Text;
        public class WinAPI {
            [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
            [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
            [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
        }
"@
        $hwnd = [WinAPI]::GetForegroundWindow()
        $sb = New-Object System.Text.StringBuilder 256
        [WinAPI]::GetWindowText($hwnd, $sb, 256) | Out-Null
        $title = $sb.ToString()
        $pid = 0
        [WinAPI]::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null
        $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
        $appName = if ($proc) { $proc.ProcessName } else { "" }
        Write-Output "$appName|||$title"
    `;

function execFileP(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/** `get_active_window` — window_info.rs. Returned shape is intentionally snake_case (`app_name`/`window_title`/`bundle_id`) to match the Rust struct's serde output verbatim — this is a RETURN value, not an invoke arg, so Tauri's camelCase auto-conversion never applied to it in the first place (confirmed against every frontend reader: behaviorSensor.ts, toolExecutor.ts, computerTools.ts all read `.app_name`/`.window_title`/`.bundle_id`). */
async function getActiveWindow() {
  if (process.platform === 'darwin') {
    const stdout = await execFileP('osascript', ['-e', MACOS_ACTIVE_WINDOW_SCRIPT]);
    const text = String(stdout).trim();
    const parts = text.split('|||');
    return {
      app_name: parts[0] ?? '',
      window_title: parts[1] ?? '',
      bundle_id: parts[2] ? parts[2] : null,
    };
  }
  if (process.platform === 'win32') {
    const stdout = await execFileP('powershell', ['-NoProfile', '-Command', WINDOWS_ACTIVE_WINDOW_SCRIPT]);
    const text = String(stdout).trim();
    const parts = text.split('|||');
    const processName = parts[0] ?? '';
    return {
      app_name: processName,
      window_title: parts[1] ?? '',
      bundle_id: processName ? processName : null,
    };
  }
  throw new Error('Active window detection not supported on this platform');
}

/** `get_abu_window_id` — computer_use.rs:126. Rust returns the main window's macOS NSWindow.windowNumber(); ported here via the same getMediaSourceId() parse as get_overlay_window_id (see report for the CGWindowID-equivalence caveat). Rust errors on non-macOS — matched here. */
function getAbuWindowId() {
  if (process.platform !== 'darwin') {
    throw new Error('get_abu_window_id is only supported on macOS');
  }
  const win = mainWin();
  if (!win) throw new Error('main window not found');
  const id = parseMediaSourceWindowId(win);
  if (id == null) throw new Error('Failed to resolve window id from getMediaSourceId()');
  return id;
}

// ─────────────────────────────────────────────────────────────────────────
// 4. Pet — src-tauri/src/pet.rs. `pet.html` is a genuine separate Vite entry
//    (see module header) rendering PetApp.tsx directly — real wiring, not a
//    placeholder.
// ─────────────────────────────────────────────────────────────────────────

/** @type {import('electron').BrowserWindow | null} */
let petWindow = null;
const PET_SIZE = 80;
const PET_PRELOAD = path.join(__dirname, 'preload.cjs'); // full preload — pet.html is a real @tauri-apps/api-using React bundle, same as the main window

/** `pet_show` — pet.rs:48. */
function petShow() {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.show();
    return null;
  }
  const display = screen.getPrimaryDisplay();
  const { x: dx, y: dy, width, height } = display.bounds;
  const x = Math.round(dx + width - PET_SIZE - 100);
  const y = Math.round(dy + height - PET_SIZE - 100);
  petWindow = new BrowserWindow({
    x,
    y,
    width: PET_SIZE,
    height: PET_SIZE,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    minimizable: false, // desktop pet stays put — the agent's minimize-all must not shrink it away
    skipTaskbar: true,
    show: false,
    // Rust's `accept_first_mouse(true)`: the pet usually isn't the key window
    // when a notification pops up, so the FIRST click must both activate the
    // window and be delivered to the webview (not just wake the window).
    acceptFirstMouse: true,
    webPreferences: {
      preload: PET_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  petWindow.setAlwaysOnTop(true, 'floating');
  applyAllSpaces(petWindow);
  void petWindow.loadFile(resolveHtml('pet.html'));
  showWhenReady(petWindow);
  return null;
}

/** `pet_hide` — pet.rs:198 (hide, not destroy — keeps the WebView alive for a quick re-show, matching Rust). */
function petHide() {
  if (petWindow && !petWindow.isDestroyed()) petWindow.hide();
  return null;
}

/** `pet_focus_main` — pet.rs:222 (async in Rust only because unminimize/set_focus are fallible Results there; no await needed on the Electron side). */
function petFocusMain() {
  const win = mainWin();
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
  return null;
}

/** `pet_set_frame {width,height,anchorBottom,anchorRight}` — pet.rs:119. camelCase wire args (frontend's PetApp.tsx:137/160 send `anchorBottom`/`anchorRight`; Tauri auto-cased those to `anchor_bottom`/`anchor_right`). Electron's `setBounds` is a single native call, same one-frame-update intent as Rust's `NSWindow.setFrame_display` (no separate move-then-resize step to visibly flicker). */
function petSetFrame(args) {
  if (!petWindow || petWindow.isDestroyed()) return null;
  const width = Math.round(Number(args.width) || 0);
  const height = Math.round(Number(args.height) || 0);
  const anchorBottom = !!args.anchorBottom;
  const anchorRight = !!args.anchorRight;
  const cur = petWindow.getBounds();
  let x = anchorRight ? cur.x + cur.width - width : cur.x;
  let y = anchorBottom ? cur.y + cur.height - height : cur.y;
  // Clamp to the workArea so a frame change can't push the pet off-screen. The
  // frontend's anchor choice differs between menu-open (top-fixed) and the
  // collapse (mode-based, bottom-fixed when the pet sits in the lower half),
  // which otherwise drove the window down past the bottom edge on menu close.
  const wa = screen.getDisplayNearestPoint({ x: cur.x, y: cur.y }).workArea;
  x = Math.max(wa.x, Math.min(x, wa.x + wa.width - width));
  y = Math.max(wa.y, Math.min(y, wa.y + wa.height - height));
  petWindow.setBounds({ x, y, width, height });
  return null;
}

function destroyPetWindow() {
  if (petWindow && !petWindow.isDestroyed()) petWindow.destroy();
  petWindow = null;
}

// ─────────────────────────────────────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────────────────────────────────────

const GUI_CMDS = new Set([
  'update_tray_menu',
  'update_tray_notice_count',
  'show_screen_border',
  'hide_screen_border',
  'get_overlay_window_id',
  'get_active_window',
  'get_abu_window_id',
  'pet_show',
  'pet_hide',
  'pet_focus_main',
  'pet_set_frame',
]);

/**
 * @param {import('electron').App} app unused today — kept for signature
 *   parity with the other `*Dispatch(app, cmd, args)` families.
 * @param {string} cmd
 * @param {Record<string, unknown>} args
 */
function guiDispatch(app, cmd, args) {
  void app;
  if (!GUI_CMDS.has(cmd)) return GUI_MISS;
  const a = args || {};
  switch (cmd) {
    case 'update_tray_menu':
      return updateTrayMenu(a);
    case 'update_tray_notice_count':
      return updateTrayNoticeCount(a);
    case 'show_screen_border':
      return showScreenBorder(a);
    case 'hide_screen_border':
      return hideScreenBorder();
    case 'get_overlay_window_id':
      return getOverlayWindowId();
    case 'get_active_window':
      return getActiveWindow();
    case 'get_abu_window_id':
      return getAbuWindowId();
    case 'pet_show':
      return petShow();
    case 'pet_hide':
      return petHide();
    case 'pet_focus_main':
      return petFocusMain();
    case 'pet_set_frame':
      return petSetFrame(a);
    default:
      return GUI_MISS;
  }
}

/**
 * Schedule tray creation at app startup — call once from registerTauriHost(app).
 *
 * The tray is created AFTER the first window exists, matching WorkBuddy and
 * Cursor (both `createWindow(); initializeTray()`). Reverse-engineering those
 * apps showed none rely on a create-at-whenReady + retry-nudge scheme; they
 * simply create the tray once a window is up. Creating the NSStatusItem earlier
 * — as this module used to, since initGuiHost runs (via registerTauriHost)
 * BEFORE main.cjs's createWindow() — intermittently failed to draw the macOS
 * menu-bar icon until the app was first activated (dock click), which is the
 * exact "托盘时有时无" symptom. Deferring to the first `browser-window-created`
 * (the main window — pet/overlay windows are only created later, on demand)
 * removes the pre-window window. Wrapped so a tray failure never aborts boot.
 */
function initGuiHost(app) {
  const make = () => {
    try {
      createTray();
    } catch (err) {
      console.error('[guiHost] createTray failed', err);
    }
  };
  // Defensive: if a window already exists (re-init / verify harness), create now.
  if (mainWin()) {
    make();
    return;
  }
  app.once('browser-window-created', () => make());
}

/** No orphans on quit: tear down every window/tray this module created. */
function teardownGuiHost() {
  destroyOverlayWindows();
  destroyPetWindow();
  destroyTray();
}

/** Test/verify-only: whether the tray icon has been created. */
function hasTray() {
  return tray != null;
}

module.exports = { guiDispatch, GUI_MISS, initGuiHost, teardownGuiHost, hasTray };
