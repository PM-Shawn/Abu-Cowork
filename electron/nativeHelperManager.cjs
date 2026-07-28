/**
 * Electron main-side manager for the native-helper (Phase 2 F10 integration).
 *
 * The native-helper (electron/native-helper/, a standalone Rust binary) hosts the
 * computer-use / accessibility family — input synthesis (enigo), screen capture
 * (xcap/CoreGraphics), and the AXUIElement session cache — behind an NDJSON
 * JSON-RPC stdio protocol. This module spawns it (lazily, on first use — most
 * sessions never touch computer-use), routes the relevant `invoke()` commands to
 * it, and returns the results.
 *
 * Why a long-lived process (not spawn-per-call): the AX family caches CFRetain'd
 * element references in a process-global map (ax_snapshot returns a session_id,
 * ax_press/ax_set_value operate on cached elements by id). That cache only
 * survives if the SAME helper process handles the whole snapshot→press sequence
 * — exactly what a persistent process gives us (and the koffi-in-Node
 * alternative would have had to reimplement the CFRetain/Release lifecycle by
 * hand). A crash drops the cache; the frontend re-snapshots, so respawn-on-next-
 * call is safe.
 *
 * Arg convention (mirrors Tauri): the frontend calls e.g.
 * `invoke('ax_press', { sessionId, elementId })` — camelCase, because Tauri
 * auto-cased camelCase JS keys to the snake_case Rust params. Electron's raw IPC
 * does NOT, and the helper reads snake_case (session_id/element_id) just like the
 * Rust did, so this router converts the arg keys camelCase→snake_case before
 * sending — reproducing Tauri's boundary behavior. Return values pass through
 * unchanged (the helper already returns snake_case serde JSON, which the frontend
 * reads as-is, same as every other command).
 *
 * No orphans: the helper child is killed on shell exit + termination signals,
 * same net as electron/mcpBridge.cjs (they don't overlap — mcpBridge owns the
 * sidecar + MCP servers, this owns the native-helper).
 */
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

/** Sentinel returned when `cmd` isn't a native-helper command. */
const NATIVE_HELPER_MISS = Symbol('native-helper-dispatch-miss');

// Commands routed to the helper. Input synthesis + screen capture + TCC checks
// + the AX session-cache family. (get_abu_window_id / overlay / get_active_window
// stay in Electron main — they need the window handle / a GUI window / and are
// handled elsewhere. Permission prompts also stay in Electron main so macOS
// attributes them to the Abu application instead of this command-line child.)
const HELPER_CMDS = new Set([
  'resolve_app_identity',
  'mouse_click',
  'mouse_move',
  'mouse_scroll',
  'mouse_drag',
  'keyboard_type',
  'keyboard_press',
  'capture_screen',
  'capture_screen_excluding',
  'check_macos_permissions',
  'ax_snapshot',
  'ax_press',
  'ax_set_value',
  'ax_perform_action',
  'ax_close_session',
  'activate_app',
]);

// Built (release) helper binary.
//  - Packaged: electron-builder ships it via extraResources at
//    <resources>/native-helper/native-helper[.exe] (see electron-builder.yml).
//  - Dev: the cargo build output under electron/native-helper/target/release/.
function nativeHelperExecutableName(platform = process.platform) {
  return platform === 'win32' ? 'native-helper.exe' : 'native-helper';
}

function resolveHelperPath(options = {}) {
  const platform = options.platform || process.platform;
  let packaged = options.packaged;
  if (typeof packaged !== 'boolean') {
    packaged = false;
    try {
      packaged = require('electron').app.isPackaged;
    } catch {
      /* plain-Node context (harness) — treat as dev */
    }
  }
  const executable = nativeHelperExecutableName(platform);
  const resourcesPath = options.resourcesPath || process.resourcesPath;
  return packaged
    ? path.join(resourcesPath, 'native-helper', executable)
    : path.join(__dirname, 'native-helper', 'target', 'release', executable);
}
const HELPER_PATH = resolveHelperPath();

const CALL_TIMEOUT_MS = 30_000;

/** @type {import('node:child_process').ChildProcess | null} */
let child = null;
let nextId = 1;
/** id -> { resolve, reject, timer } */
const pending = new Map();
let stdoutBuf = '';

/** Convert an args object's keys camelCase→snake_case (shallow — these command
 * args are flat), reproducing Tauri's JS→Rust param casing. */
function toSnakeArgs(args) {
  if (!args || typeof args !== 'object') return {};
  const out = {};
  for (const key of Object.keys(args)) {
    const snake = key.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
    out[snake] = args[key];
  }
  return out;
}

function rejectAllPending(err) {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.reject(err);
  }
  pending.clear();
}

function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    // Non-JSON stdout line — ignore (helper only emits JSON on stdout).
    return;
  }
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  clearTimeout(p.timer);
  if (msg.error !== undefined && msg.error !== null) {
    p.reject(new Error(typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error)));
  } else {
    p.resolve(msg.result);
  }
}

function ensureChild() {
  if (child && !child.killed && child.exitCode === null) return child;
  if (!fs.existsSync(HELPER_PATH)) {
    throw new Error(
      `native-helper binary not found at ${HELPER_PATH} — build it with \`cd electron/native-helper && cargo build --release\``
    );
  }
  child = spawn(HELPER_PATH, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  stdoutBuf = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      handleLine(line);
    }
  });

  // stderr is the helper's diagnostic channel — surface at debug level only.
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    const s = String(d).trim();
    if (s) console.log(`[native-helper] ${s}`);
  });

  const onGone = (reason) => {
    rejectAllPending(new Error(`native-helper exited (${reason}); it will respawn on the next call`));
    child = null;
  };
  child.on('error', (err) => onGone(err.message));
  child.on('close', (code, sig) => onGone(`code=${code} sig=${sig}`));

  return child;
}

/**
 * Send one JSON-RPC call to the helper and await its response.
 * @param {string} method
 * @param {Record<string, unknown>} params
 * @returns {Promise<unknown>}
 */
function callHelper(method, params) {
  return new Promise((resolve, reject) => {
    let c;
    try {
      c = ensureChild();
    } catch (err) {
      reject(err);
      return;
    }
    const id = nextId++;
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`native-helper call '${method}' timed out after ${CALL_TIMEOUT_MS}ms`));
      }
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
      c.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Dispatch a `tauri:invoke` command to the native-helper if it owns it.
 * @param {string} cmd
 * @param {Record<string, unknown>} args
 * @returns {Promise<unknown> | typeof NATIVE_HELPER_MISS}
 */
function nativeHelperDispatch(cmd, args) {
  if (!HELPER_CMDS.has(cmd)) return NATIVE_HELPER_MISS;
  return callHelper(cmd, toSnakeArgs(args));
}

/** Kill the helper child (called on app quit; no orphans). */
function killNativeHelper() {
  if (child && !child.killed) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already dead */
    }
  }
  child = null;
}

// No orphans on shell exit or termination signals (a signal doesn't run 'exit'
// handlers, and registering one suppresses the default terminate — so reproduce
// it). Mirrors electron/mcpBridge.cjs's guard for its own children.
process.on('exit', killNativeHelper);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(sig, () => {
    killNativeHelper();
    process.exit(0);
  });
}

module.exports = {
  nativeHelperDispatch,
  NATIVE_HELPER_MISS,
  killNativeHelper,
  callHelper,
  HELPER_CMDS,
  nativeHelperExecutableName,
  resolveHelperPath,
};
