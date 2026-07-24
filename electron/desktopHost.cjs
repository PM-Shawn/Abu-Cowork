/**
 * Electron main-side "F2 desktop misc" command family (Phase 2 slice F2).
 *
 * Backs a grab-bag of Tauri custom commands + plugin families that don't fit
 * fsHost/mcpBridge/windowDispatch: LAN IP discovery, fullscreen detection
 * (Notice Gate), sleep prevention, OS trash, clipboard text + file-path
 * reads, native dialogs, the opener plugin, notification permission, process
 * relaunch/exit, and deep-link cold-start URL.
 *
 * Exports `desktopDispatch(app, cmd, payload)` — payload is
 * `{args, body, headers, event}` (mirrors fsHost's shape plus the raw
 * ipcMain event, needed here to resolve the calling BrowserWindow for modal
 * dialogs). Returns `DESKTOP_MISS` for any `cmd` it doesn't own, so
 * tauriHost.cjs's dispatch chain falls through to the next stage. Several
 * handlers here are inherently async (trash, dialogs, opener) — a returned
 * Promise is fine, tauriHost's `ipcMain.handle` callback is itself `async`
 * and just `return`s whatever this gives back, which resolves correctly.
 *
 * ## Command → contract summary (see per-handler comments for detail + the
 * Rust/frontend source each was verified against)
 *  - `get_local_ip`                                  — src-tauri/src/lib.rs
 *  - `check_fullscreen`                               — src-tauri/src/notice.rs
 *  - `set_prevent_sleep`                              — src-tauri/src/sleep_prevention.rs
 *  - `move_to_trash`                                  — src-tauri/src/trash.rs
 *  - `plugin:clipboard-manager|read_text`/`write_text`
 *  - `read_clipboard_file_paths`                      — src-tauri/src/clipboard_files.rs
 *  - `plugin:dialog|open`/`save`/`message`
 *  - `plugin:opener|open_path`/`open_url`/`reveal_item_in_dir`
 *  - `plugin:shell|open`                              — @tauri-apps/plugin-shell
 *  - `plugin:notification|is_permission_granted`
 *  - `plugin:process|restart`/`exit`
 *  - `plugin:deep-link|get_current`
 *
 * NOTE on notification: `sendNotification()` and `requestPermission()` in
 * @tauri-apps/plugin-notification (checked in node_modules) call the
 * browser-native `window.Notification` API directly — NOT `invoke()` — so
 * there is nothing to route for those two on the Electron side (Chromium's
 * renderer already implements Web Notifications backed by the native OS
 * notification center). Only `isPermissionGranted()` calls `invoke()`, and
 * only when `window.Notification.permission === 'default'`. So `notify` is
 * NOT a real command on the wire in this plugin version, despite appearing
 * in some Tauri docs/examples.
 *
 * NOTE on dialog: `ask()`/`confirm()` in @tauri-apps/plugin-dialog both
 * funnel into the SAME `plugin:dialog|message` command as `message()` (the
 * Yes/No vs Ok/Cancel button choice is resolved client-side before the
 * invoke) — there is no separate `plugin:dialog|ask` or `|confirm` command.
 *
 * NOTE on process: the task brief names `plugin:process|relaunch`, but the
 * installed @tauri-apps/plugin-process actually sends `plugin:process|restart`
 * for `relaunch()` (and `plugin:process|exit` for `exit()`). Both are
 * implemented here under their real wire names.
 */
'use strict';

const os = require('node:os');
const { shell, clipboard, dialog, powerSaveBlocker, BrowserWindow } = require('electron');

/** Sentinel returned when `cmd` isn't a desktop-misc command. */
const DESKTOP_MISS = Symbol('desktop-dispatch-miss');

// ─────────────────────────────────────────────────────────────────────────
// get_local_ip
// ─────────────────────────────────────────────────────────────────────────

/**
 * LAN IPv4 address, mirroring lib.rs::get_local_ip's intent (find the
 * machine's real network address for the Feishu/IM heartbeat + LAN-share
 * features) without shelling out to `ifconfig`. Excludes loopback/internal
 * interfaces and the 198.18.0.0/15 network-benchmark range Rust also skips
 * (some VPN/virtualization adapters squat there). Prefers RFC1918 private
 * ranges (the common home/office LAN case) over other non-internal
 * addresses (e.g. a Docker bridge or a public IP on a direct-attached NIC).
 * @returns {string | null}
 */
function getLocalIp() {
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.internal) continue;
      // Node's `family` is the string 'IPv4' on modern Node, but has been a
      // numeric 4 on some older builds — accept either.
      if (iface.family !== 'IPv4' && iface.family !== 4) continue;
      if (iface.address.startsWith('198.18.')) continue;
      candidates.push(iface.address);
    }
  }
  if (candidates.length === 0) return null;
  const isPrivate172 = (ip) => {
    const m = /^172\.(\d+)\./.exec(ip);
    return !!m && Number(m[1]) >= 16 && Number(m[1]) <= 31;
  };
  return (
    candidates.find((ip) => ip.startsWith('192.168.') || ip.startsWith('10.')) ||
    candidates.find(isPrivate172) ||
    candidates[0]
  );
}

// ─────────────────────────────────────────────────────────────────────────
// check_fullscreen
// ─────────────────────────────────────────────────────────────────────────

/**
 * GAP vs Rust: notice.rs's `check_fullscreen` queries the OS-WIDE frontmost
 * application via osascript's AXFullScreen accessibility attribute (any
 * app — Keynote, a video player, a game — not just Abu itself). Electron has
 * no cross-app fullscreen introspection without a native accessibility
 * binding (which this Phase-2 slice deliberately avoids adding). The closest
 * SAFE equivalent available here is "is Abu's own window fullscreen",
 * exposed via BrowserWindow#isFullScreen(). This still serves Notice Gate's
 * actual use (don't interrupt an immersive full-window Abu view) but will
 * NOT suppress notices while the user is fullscreen in some OTHER app —
 * documented, deliberate narrowing, not a bug.
 * @param {import('electron').IpcMainInvokeEvent | undefined} event
 * @returns {{ is_fullscreen: boolean; app_name: string | null }}
 */
function checkFullscreen(event) {
  const win = windowFor(event);
  const isFullscreen = !!(win && !win.isDestroyed() && win.isFullScreen());
  return {
    is_fullscreen: isFullscreen,
    app_name: isFullscreen ? 'Abu' : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// set_prevent_sleep
// ─────────────────────────────────────────────────────────────────────────

/** Module-scoped power-save-blocker id — null when not active (idempotent state). */
let sleepBlockerId = null;

/**
 * Toggle sleep prevention. sleep_prevention.rs uses `caffeinate -s -i`
 * (prevent system + idle sleep; NOT display sleep) on macOS and
 * SetThreadExecutionState(..|ES_SYSTEM_REQUIRED|ES_AWAYMODE_REQUIRED) on
 * Windows — neither keeps the SCREEN itself on. Electron's powerSaveBlocker
 * only offers two blocker types: 'prevent-app-suspension' (closest match —
 * keeps the system/CPU running, display may still sleep) and
 * 'prevent-display-sleep' (also forces the display to stay on — stronger
 * than Rust's behavior). Using 'prevent-display-sleep' per the task brief;
 * documenting that this is a slightly STRONGER guarantee than the Rust
 * implementation (screen won't blank either), not a functional regression.
 * Idempotent both ways, matching sleep_prevention.rs (enable-while-enabled
 * and disable-while-disabled are both no-op successes).
 * @param {boolean} enabled
 */
function setPreventSleep(enabled) {
  if (enabled) {
    if (sleepBlockerId !== null && powerSaveBlocker.isStarted(sleepBlockerId)) return null;
    sleepBlockerId = powerSaveBlocker.start('prevent-display-sleep');
  } else if (sleepBlockerId !== null) {
    if (powerSaveBlocker.isStarted(sleepBlockerId)) powerSaveBlocker.stop(sleepBlockerId);
    sleepBlockerId = null;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// move_to_trash
// ─────────────────────────────────────────────────────────────────────────

/**
 * Move a file/directory to the OS trash (Finder Trash / Recycle Bin / XDG
 * trash), mirroring trash.rs::move_to_trash. `shell.trashItem` is async and
 * REJECTS on failure (missing path, permission denied) — left to throw/
 * reject so the invoke rejects, matching Tauri's `Result<(), String>` surfacing
 * fs errors to the frontend (same convention as fsHost.cjs).
 * @param {string} targetPath
 */
async function moveToTrash(targetPath) {
  await shell.trashItem(String(targetPath));
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// clipboard-manager (text)
// ─────────────────────────────────────────────────────────────────────────

/**
 * write_text args are `{ label, text }` (label is a macOS Pasteboard-item
 * label the plugin's Rust backend can tag; Electron's clipboard module has
 * no equivalent concept at this API level) — `label` is accepted and
 * ignored, only `text` is written. read_text takes no args and returns the
 * plain string (empty string when the clipboard holds no text, matching
 * Electron's own `clipboard.readText()` contract).
 */
function clipboardWriteText(a) {
  clipboard.writeText(String((a && a.text) ?? ''));
  return null;
}
function clipboardReadText() {
  return clipboard.readText();
}

// ─────────────────────────────────────────────────────────────────────────
// read_clipboard_file_paths
// ─────────────────────────────────────────────────────────────────────────

/** Decode a `file://[localhost]/...` URL string into a plain POSIX path. */
function fileUrlToPath(url) {
  const m = /^file:\/\/(?:localhost)?(\/.*)$/.exec(url);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/**
 * Read absolute file paths currently on the clipboard (Cmd/Ctrl+C on a file
 * in Finder/Explorer), mirroring clipboard_files.rs's intent: give Cmd+V the
 * same real-path semantics as native drag-and-drop.
 *
 * macOS: `clipboard.readBuffer('public.file-url')` reads the file-url UTI
 * off NSPasteboard. KNOWN GAP vs the Rust implementation: the Rust side uses
 * objc2's `NSPasteboard::pasteboardItems()` to enumerate EVERY item on the
 * pasteboard (so a multi-file Finder copy yields all paths); Electron's
 * `clipboard` module has no multi-item pasteboard API — `readBuffer` only
 * ever exposes ONE value per UTI. So a multi-file copy here only recovers
 * the first path. Single-file copy (the common case) round-trips correctly
 * (verified — see electron/spike/f2Verify.cjs). Documented limitation, not
 * silently wrong: callers already have a graceful bitmap/name-only fallback
 * per clipboard_files.rs's own header comment.
 *
 * Windows/Linux: Electron's clipboard module exposes no built-in CF_HDROP /
 * text/uri-list parsing, and hand-rolling the DROPFILES binary struct (the
 * Rust side uses `windows::Win32::UI::Shell::DragQueryFileW`) is real
 * complexity for a best-effort convenience path — returning `[]` here is
 * honest (unknown, not "no files") rather than a wrong guess.
 * @returns {string[]}
 */
function readClipboardFilePaths() {
  if (process.platform !== 'darwin') return [];
  try {
    const buf = clipboard.readBuffer('public.file-url');
    if (!buf || buf.length === 0) return [];
    const p = fileUrlToPath(buf.toString('utf8').trim());
    return p ? [p] : [];
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────
// dialog plugin
// ─────────────────────────────────────────────────────────────────────────

/** Resolve the BrowserWindow that issued this invoke, for modal dialog parenting. */
function windowFor(event) {
  if (!event || !event.sender) return null;
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win && !win.isDestroyed() ? win : null;
  } catch {
    return null;
  }
}

/**
 * `open()` options: `{directory, multiple, title, defaultPath, filters}` —
 * `filters: [{name, extensions}]` is byte-identical to Electron's own
 * `filters` shape, no translation needed. Tauri's return contract: `null`
 * on cancel, a single path string when `multiple` is falsy, `string[]` when
 * `multiple` is true — translated from Electron's `{canceled, filePaths}`.
 */
async function dialogOpen(event, options) {
  const opts = options || {};
  const properties = [opts.directory ? 'openDirectory' : 'openFile'];
  if (opts.multiple) properties.push('multiSelections');
  const electronOpts = { title: opts.title, defaultPath: opts.defaultPath, filters: opts.filters, properties };
  const win = windowFor(event);
  const result = win ? await dialog.showOpenDialog(win, electronOpts) : await dialog.showOpenDialog(electronOpts);
  if (result.canceled || result.filePaths.length === 0) return null;
  return opts.multiple ? result.filePaths : result.filePaths[0];
}

/**
 * `save()` options: `{title, defaultPath, filters}`. Tauri returns `null` on
 * cancel, else the chosen path string — matches Electron's
 * `{canceled, filePath}` directly.
 */
async function dialogSave(event, options) {
  const opts = options || {};
  const electronOpts = { title: opts.title, defaultPath: opts.defaultPath, filters: opts.filters };
  const win = windowFor(event);
  const result = win ? await dialog.showSaveDialog(win, electronOpts) : await dialog.showSaveDialog(electronOpts);
  return result.canceled ? null : result.filePath || null;
}

/**
 * `buttons` arrives pre-shaped by the JS plugin's `buttonsToRust()`: either
 * `undefined`, a bare enum string (`'Ok'|'OkCancel'|'YesNo'|'YesNoCancel'`),
 * or one of `{OkCustom}`/`{OkCancelCustom:[ok,cancel]}`/
 * `{YesNoCancelCustom:[yes,no,cancel]}`. Returns the ordered button labels
 * Electron's `showMessageBox` needs; the frontend later matches the
 * RESOLVED label string against its expected okLabel, so label order/text
 * must round-trip exactly.
 */
function resolveButtons(buttons) {
  // The Ok button label MUST be exactly 'Ok' (not 'OK'): confirm() in
  // @tauri-apps/plugin-dialog defaults `okLabel` to 'Ok' and returns
  // `(clickedLabel === okLabel)`, so a 'OK' here would make every default
  // confirm() (delete IM channel / unbind enterprise / end IM session) return
  // false even when the user clicks Ok. 'Ok'/'Cancel'/'Yes'/'No' are Tauri's
  // canonical enum labels.
  if (buttons == null) return ['Ok'];
  if (typeof buttons === 'string') {
    switch (buttons) {
      case 'OkCancel':
        return ['Ok', 'Cancel'];
      case 'YesNo':
        return ['Yes', 'No'];
      case 'YesNoCancel':
        return ['Yes', 'No', 'Cancel'];
      default:
        return ['Ok'];
    }
  }
  if (buttons.OkCustom) return [String(buttons.OkCustom)];
  if (buttons.OkCancelCustom) return buttons.OkCancelCustom.map(String);
  if (buttons.YesNoCancelCustom) return buttons.YesNoCancelCustom.map(String);
  return ['OK'];
}

/**
 * Backs `message()`/`ask()`/`confirm()` — all three funnel into this single
 * command from the JS plugin (see file header note). args:
 * `{message, title, kind, buttons}`. `kind` is Tauri's
 * `'info'|'warning'|'error'`, mapped to Electron's `dialog` box `type`
 * directly. Returns the LABEL of the clicked button (string) — the
 * frontend's ask()/confirm() wrappers compare this against their expected
 * okLabel to produce a boolean.
 */
async function dialogMessage(event, a) {
  const opts = a || {};
  const labels = resolveButtons(opts.buttons);
  const type = opts.kind === 'error' ? 'error' : opts.kind === 'warning' ? 'warning' : 'info';
  const electronOpts = { type, title: opts.title, message: String(opts.message ?? ''), buttons: labels };
  const win = windowFor(event);
  const result = win ? await dialog.showMessageBox(win, electronOpts) : await dialog.showMessageBox(electronOpts);
  return labels[result.response];
}

// ─────────────────────────────────────────────────────────────────────────
// opener plugin
// ─────────────────────────────────────────────────────────────────────────

/**
 * `open_path` args: `{path, with}`. `with` (an explicit non-default app to
 * open with, e.g. `openPath(p, 'vlc')`) is NOT supported by Electron's
 * `shell.openPath` — it only opens with the OS default handler. Not
 * exercised anywhere in src/ (openWithDefaultApp.ts always calls the
 * 1-arg form), so this is a documented no-op for that param rather than a
 * blocking gap. `shell.openPath` resolves with `''` on success or an error
 * string on failure — thrown here so the invoke rejects like Tauri's
 * `Result<(), String>` would.
 */
async function openerOpenPath(a) {
  const err = await shell.openPath(String((a && a.path) || ''));
  if (err) throw new Error(err);
  return null;
}

/** `open_url` args: `{url, with}` — same `with` caveat as open_path above. */
async function openerOpenUrl(a) {
  await shell.openExternal(String((a && a.url) || ''));
  return null;
}

/**
 * `reveal_item_in_dir` args: `{paths}` — the JS plugin always wraps its
 * single-path argument into a 1-element array before invoking (see
 * node_modules/@tauri-apps/plugin-opener), so `paths` is an array even
 * though every call site in src/ passes exactly one path. Reveals each in
 * the OS file manager; `showItemInFolder` has no async completion signal.
 */
function openerRevealItemInDir(a) {
  const paths = (a && a.paths) || [];
  for (const p of paths) {
    if (typeof p === 'string' && p) shell.showItemInFolder(p);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// shell plugin (`open()` only — see below)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Matches a URI scheme prefix (`scheme:...`) with a scheme at least 2 chars
 * long, so it fires for `http:`, `https:`, `mailto:`, `tel:`, `file:`, etc.
 * but NOT for a bare single-letter Windows drive prefix like `C:\Users\...`
 * (which would otherwise false-positive as a "scheme" under a looser
 * `[a-zA-Z][a-zA-Z0-9+.-]*:` pattern — a drive-letter path has zero chars
 * between the letter and the colon).
 */
const URL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]+:/;

/**
 * `plugin:shell|open` args: `{path, with}` (verified against
 * node_modules/@tauri-apps/plugin-shell/dist-js/index.js's `open()`, the
 * ONLY export of this plugin used in src/ — grep confirms every call site
 * imports just `open`, never `Command`/`Child`, so `execute`/`spawn`/`kill`/
 * `stdin_write` are intentionally NOT handled here; they fall through to the
 * generic stub via `default: return DESKTOP_MISS` below). `with` (an
 * explicit non-default app, e.g. `open(url, 'firefox')`) has no Electron
 * `shell` module equivalent — same documented no-op gap as opener's
 * `open_path`/`open_url` above; unused in src/ (every `open()` call site
 * passes just the one path/URL arg).
 *
 * `shell.openPath` resolves with `''` on success or an error string on
 * failure — thrown here so the invoke rejects, matching Tauri's
 * `Result<(), String>` surfacing. `shell.openExternal` rejects natively on
 * failure, so no manual throw is needed for the URL branch.
 */
async function shellOpen(a) {
  const p = String((a && a.path) || '');
  if (URL_SCHEME_RE.test(p)) {
    await shell.openExternal(p);
  } else {
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// notification plugin (permission check only — see file header note)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Electron desktop apps have no per-origin permission-prompt model like a
 * browser — system notification access is either OS-level (macOS may show
 * its own one-time system prompt the first time a Notification is actually
 * shown) or unconditionally available. Treat as always-granted, matching
 * the task brief; the frontend's actual `sendNotification()`/
 * `requestPermission()` calls bypass this module entirely (native
 * `window.Notification`, see file header).
 */
function notificationIsPermissionGranted() {
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// process plugin
// ─────────────────────────────────────────────────────────────────────────

function processRestart(app) {
  // If a downloaded update is pending (updaterHost's download_and_install
  // completed), restart must apply it: quitAndInstall replaces the app and
  // relaunches. Plain relaunch would boot the OLD version and rely on the
  // next quit to install — the user clicked "restart to update", so install
  // now. Lazy require avoids a circular import at module load
  // (updaterHost ← tauriHost ← this module's caller).
  const { consumePendingInstall } = require('./updaterHost.cjs');
  const au = consumePendingInstall();
  if (au) {
    au.quitAndInstall();
    return null;
  }
  app.relaunch();
  app.exit(0);
  return null;
}

function processExit(app, a) {
  app.exit(Number((a && a.code) || 0));
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// deep-link plugin
// ─────────────────────────────────────────────────────────────────────────

/**
 * `get_current()` — the URL(s) that cold-launched the app. Delegates to
 * deepLinkHost, which owns the protocol registration + open-url/argv parsing
 * (see electron/deepLinkHost.cjs). Returns the cold-start URLs as a string[],
 * or null when there were none: useDeepLinkEnroll.ts does `if (!urls) return;`,
 * matching the Tauri plugin's "no deep link" return.
 */
function deepLinkGetCurrent() {
  return require('./deepLinkHost.cjs').getCurrentDeepLinks();
}

// ─────────────────────────────────────────────────────────────────────────
// dispatch
// ─────────────────────────────────────────────────────────────────────────

/**
 * @param {import('electron').App} app
 * @param {string} cmd
 * @param {{ args?: Record<string, unknown>; body?: unknown; headers?: Record<string, string>; event?: import('electron').IpcMainInvokeEvent }} payload
 */
function desktopDispatch(app, cmd, payload) {
  const { args, event } = payload || {};
  const a = args || {};

  switch (cmd) {
    case 'get_local_ip':
      return getLocalIp();

    case 'check_fullscreen':
      return checkFullscreen(event);

    case 'set_prevent_sleep':
      return setPreventSleep(!!a.enabled);

    case 'move_to_trash':
      return moveToTrash(a.path);

    case 'plugin:clipboard-manager|write_text':
      return clipboardWriteText(a);
    case 'plugin:clipboard-manager|read_text':
      return clipboardReadText();

    case 'read_clipboard_file_paths':
      return readClipboardFilePaths();

    case 'plugin:dialog|open':
      return dialogOpen(event, a.options);
    case 'plugin:dialog|save':
      return dialogSave(event, a.options);
    case 'plugin:dialog|message':
      return dialogMessage(event, a);

    case 'plugin:opener|open_path':
      return openerOpenPath(a);
    case 'plugin:opener|open_url':
      return openerOpenUrl(a);
    case 'plugin:opener|reveal_item_in_dir':
      return openerRevealItemInDir(a);

    case 'plugin:shell|open':
      return shellOpen(a);

    case 'plugin:notification|is_permission_granted':
      return notificationIsPermissionGranted();

    case 'plugin:process|restart':
      return processRestart(app);
    case 'plugin:process|exit':
      return processExit(app, a);

    case 'plugin:deep-link|get_current':
      return deepLinkGetCurrent();

    default:
      return DESKTOP_MISS;
  }
}

module.exports = { desktopDispatch, DESKTOP_MISS };
