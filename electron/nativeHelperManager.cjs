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
const { runtimeState } = require('./runtimeObservability.cjs');
const { COMPUTER_USE_REQUEST_CONTEXT_ARG } = require('./computerUseCommands.cjs');

/** Sentinel returned when `cmd` isn't a native-helper command. */
const NATIVE_HELPER_MISS = Symbol('native-helper-dispatch-miss');
const NATIVE_HELPER_PROTOCOL_VERSION = 2;

// Commands routed to the helper. Input synthesis + screen capture + TCC checks
// + the AX session-cache family. (get_abu_window_id / overlay / get_active_window
// stay in Electron main — they need the window handle / a GUI window / and are
// handled elsewhere. Permission prompts also stay in Electron main so macOS
// attributes them to the Abu application instead of this command-line child.)
const HELPER_CMDS = new Set([
  'native_helper_health',
  'input_lease_begin',
  'input_lease_activate',
  'input_lease_commit_observation',
  'input_lease_observe',
  'input_lease_pause',
  'input_lease_resume',
  'input_lease_end',
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
  'frontmost_app_identity',
  'ax_snapshot',
  'ax_press',
  'ax_set_value',
  'ax_replace_text',
  'ax_perform_action',
  'ax_restore_focus',
  'ax_close_session',
  'activate_app',
  'list_apps',
  'list_windows',
  'get_window',
  'get_window_graph',
  'frontmost_matches_target',
  'activate_window',
  'launch_app',
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
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
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
    ? platformPath.join(resourcesPath, 'native-helper', executable)
    : platformPath.join(__dirname, 'native-helper', 'target', 'release', executable);
}
const HELPER_PATH = resolveHelperPath();

const DEFAULT_CALL_TIMEOUT_MS = 10_000;
const OBSERVATION_CALL_TIMEOUT_MS = 15_000;
const HELPER_EVENT_TYPES = new Set([
  'user-interrupted',
  'user-input-detected',
  'window-invalidated',
]);

function resolveHelperCallTimeoutMs(method) {
  if (method === 'hello' || method === 'health' || method === 'ping') return 5_000;
  if (
    method === 'ax_snapshot'
    || method === 'capture_screen'
    || method === 'capture_screen_excluding'
    || method === 'get_window_state'
    || method === 'get_window_graph'
    || method === 'launch_app'
    || method === 'activate_app'
  ) {
    return OBSERVATION_CALL_TIMEOUT_MS;
  }
  return DEFAULT_CALL_TIMEOUT_MS;
}

function normalizeHelperEvent(message) {
  if (!message || typeof message !== 'object' || !HELPER_EVENT_TYPES.has(message.event)) {
    return null;
  }
  const context = message.context && typeof message.context === 'object'
    ? message.context
    : {};
  return Object.freeze({
    type: message.event,
    conversationId: typeof context.conversation_id === 'string'
      ? context.conversation_id.slice(0, 256)
      : null,
    loopId: typeof context.loop_id === 'string'
      ? context.loop_id.slice(0, 256)
      : null,
    reason: typeof message.reason === 'string'
      ? message.reason.slice(0, 160)
      : null,
  });
}

function createSerialExecutor() {
  let tail = Promise.resolve();
  let epoch = 0;
  return {
    run(task) {
      const scheduledEpoch = epoch;
      const execute = async () => {
        if (scheduledEpoch !== epoch) {
          throw new Error('native-helper request was invalidated before execution');
        }
        return task();
      };
      const result = tail.then(execute, execute);
      tail = result.catch(() => undefined);
      return result;
    },
    invalidate() {
      epoch += 1;
    },
  };
}

const HELPER_SUPERVISOR_STATES = Object.freeze([
  'stopped',
  'starting',
  'ready',
  'busy',
  'awaiting-approval',
  'resetting',
  'failed',
]);
const APPROVAL_SAFE_HELPER_METHODS = new Set([
  'health',
  'ping',
  'input_lease_resume',
  'input_lease_end',
]);

/** Explicit lifecycle state for the long-lived helper process. */
function createNativeHelperSupervisorState(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const onTransition = typeof options.onTransition === 'function'
    ? options.onTransition
    : null;
  let state = 'stopped';
  let generation = 0;
  let activeMethod = null;
  let pendingCount = 0;
  let approvalPaused = false;
  let lastTransitionAt = now();
  let lastReason = 'initial';

  const snapshot = () => Object.freeze({
    state,
    generation,
    activeMethod,
    pendingCount,
    approvalPaused,
    lastTransitionAt,
    lastReason,
  });
  const transition = (nextState, reason, patch = {}) => {
    if (!HELPER_SUPERVISOR_STATES.includes(nextState)) {
      throw new Error(`invalid native-helper supervisor state '${String(nextState)}'`);
    }
    state = nextState;
    if (Object.hasOwn(patch, 'generation')) generation = patch.generation;
    if (Object.hasOwn(patch, 'activeMethod')) activeMethod = patch.activeMethod;
    if (Object.hasOwn(patch, 'pendingCount')) pendingCount = patch.pendingCount;
    if (Object.hasOwn(patch, 'approvalPaused')) approvalPaused = patch.approvalPaused;
    lastTransitionAt = now();
    lastReason = String(reason || nextState).slice(0, 160);
    const value = snapshot();
    try { onTransition?.(value); } catch { /* telemetry cannot break CU */ }
    return value;
  };

  const api = {
    snapshot,
    canDispatch(method) {
      return !approvalPaused || APPROVAL_SAFE_HELPER_METHODS.has(method);
    },
    spawnStarted(nextGeneration) {
      return transition('starting', 'spawn-started', {
        generation: nextGeneration,
        activeMethod: null,
        pendingCount: 0,
        approvalPaused: false,
      });
    },
    ready(nextGeneration = generation) {
      return transition('ready', 'handshake-ready', {
        generation: nextGeneration,
        activeMethod: null,
        pendingCount: 0,
        approvalPaused: false,
      });
    },
    requestStarted(method, nextPendingCount) {
      if (!api.canDispatch(method)) {
        throw new Error(
          `native-helper is awaiting user approval; '${method}' is blocked until the input lease resumes`,
        );
      }
      return transition(
        state === 'starting' && method === 'hello' ? 'starting' : 'busy',
        `request:${method}`,
        { activeMethod: method, pendingCount: nextPendingCount },
      );
    },
    requestCompleted(method, nextPendingCount) {
      if (method === 'hello') {
        return transition('starting', 'hello-received', {
          activeMethod: null,
          pendingCount: nextPendingCount,
        });
      }
      if (method === 'input_lease_pause') {
        return transition('awaiting-approval', 'approval-paused', {
          activeMethod: null,
          pendingCount: nextPendingCount,
          approvalPaused: true,
        });
      }
      if (method === 'input_lease_resume' || method === 'input_lease_end') {
        return transition('ready', `approval-${method === 'input_lease_resume' ? 'resumed' : 'ended'}`, {
          activeMethod: null,
          pendingCount: nextPendingCount,
          approvalPaused: false,
        });
      }
      return transition(approvalPaused ? 'awaiting-approval' : 'ready', 'request-completed', {
        activeMethod: null,
        pendingCount: nextPendingCount,
      });
    },
    requestFailed(method, nextPendingCount, reason = 'request-failed') {
      const remainsPaused = approvalPaused
        || method === 'input_lease_resume'
        || method === 'input_lease_end';
      return transition(remainsPaused ? 'awaiting-approval' : 'ready', reason, {
        activeMethod: null,
        pendingCount: nextPendingCount,
        approvalPaused: remainsPaused,
      });
    },
    resetting(reason) {
      return transition('resetting', reason, { activeMethod: null });
    },
    stopped(nextGeneration, reason) {
      return transition('stopped', reason, {
        generation: nextGeneration,
        activeMethod: null,
        pendingCount: 0,
        approvalPaused: false,
      });
    },
    failed(nextGeneration, reason) {
      return transition('failed', reason, {
        generation: nextGeneration,
        activeMethod: null,
        pendingCount: 0,
        approvalPaused: false,
      });
    },
  };
  return Object.freeze(api);
}

/** @type {import('node:child_process').ChildProcess | null} */
let child = null;
let nextId = 1;
/** id -> { resolve, reject, timer } */
const pending = new Map();
let stdoutBuf = '';
let helperHandshake = null;
let lastDriverCapabilities = null;
const helperEventListeners = new Set();
const requestScheduler = createSerialExecutor();
// Monotonically changes whenever the helper process identity changes. Host-side
// Computer Use state binds to this generation so a crash/restart cannot reuse an
// observation or AX session created by the previous native process.
let helperGeneration = 0;
let hasSpawnedHelper = false;
const helperSupervisor = createNativeHelperSupervisorState({
  onTransition: (snapshot) => runtimeState.noteNativeHelperSupervisorTransition?.(snapshot),
});

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

const HELPER_EXECUTIONS = new Set(['not-executed', 'dispatched', 'outcome-unknown']);

/**
 * Turn a helper `error` payload into an Error that carries the structured
 * verdict as `error.helper = { code, execution, retryable }`.
 *
 * The helper classifies at the raising site (electron/native-helper/src/error.rs);
 * this only preserves that classification across the process boundary. A
 * legacy string error — or a malformed object — becomes `legacy` with the
 * pessimistic `outcome-unknown` verdict, so nothing downstream can treat an
 * unclassified failure as safe to replay. Nobody may branch on `message`.
 */
function normalizeHelperError(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const code = typeof raw.code === 'string' && raw.code.trim() ? raw.code.trim() : null;
    const execution = HELPER_EXECUTIONS.has(raw.execution) ? raw.execution : null;
    const message = typeof raw.message === 'string' && raw.message
      ? raw.message
      : JSON.stringify(raw);
    if (code && execution) {
      const error = new Error(message);
      error.helper = Object.freeze({ code, execution, retryable: raw.retryable === true });
      return error;
    }
    const error = new Error(message);
    error.helper = Object.freeze({ code: 'legacy', execution: 'outcome-unknown', retryable: false });
    return error;
  }
  const error = new Error(typeof raw === 'string' ? raw : JSON.stringify(raw));
  error.helper = Object.freeze({ code: 'legacy', execution: 'outcome-unknown', retryable: false });
  return error;
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
  const helperEvent = normalizeHelperEvent(msg);
  if (helperEvent) {
    for (const listener of helperEventListeners) {
      try {
        listener(helperEvent);
      } catch (error) {
        console.warn('[native-helper] event listener failed', error);
      }
    }
    return;
  }
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  clearTimeout(p.timer);
  if (msg.error !== undefined && msg.error !== null) {
    p.reject(normalizeHelperError(msg.error));
  } else {
    p.resolve(msg.result);
  }
}

function ensureChild() {
  if (child && !child.killed && child.exitCode === null) return child;
  if (!fs.existsSync(HELPER_PATH)) {
    const failedGeneration = helperGeneration + 1;
    helperSupervisor.failed(failedGeneration, 'binary-not-found');
    runtimeState.noteNativeHelperSpawnStarted(failedGeneration, hasSpawnedHelper);
    runtimeState.noteNativeHelperSpawnFailed(failedGeneration, 'binary_not_found');
    throw new Error(
      `native-helper binary not found at ${HELPER_PATH} — build it with \`cd electron/native-helper && cargo build --release\``
    );
  }
  const spawnedChild = spawn(HELPER_PATH, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  child = spawnedChild;
  helperGeneration += 1;
  const spawnedGeneration = helperGeneration;
  helperSupervisor.spawnStarted(spawnedGeneration);
  runtimeState.noteNativeHelperSpawnStarted(spawnedGeneration, hasSpawnedHelper);
  hasSpawnedHelper = true;
  stdoutBuf = '';
  helperHandshake = null;

  spawnedChild.stdout.setEncoding('utf8');
  spawnedChild.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      handleLine(line);
    }
  });

  // stderr is the helper's diagnostic channel — surface at debug level only.
  spawnedChild.stderr.setEncoding('utf8');
  spawnedChild.stderr.on('data', (d) => {
    const s = String(d).trim();
    if (s) console.log(`[native-helper] ${s}`);
  });

  const onGone = (reason) => {
    // `error` and `close` may both fire. A deliberate kill may also be followed
    // by a fast respawn, so an old child's late close event must never clear the
    // replacement child or reject its pending calls.
    if (child !== spawnedChild) return;
    runtimeState.noteNativeHelperCrashed(spawnedGeneration, reason);
    rejectAllPending(new Error(`native-helper exited (${reason}); it will respawn on the next call`));
    child = null;
    helperHandshake = null;
    lastDriverCapabilities = null;
    helperGeneration += 1;
    helperSupervisor.failed(helperGeneration, reason);
  };
  spawnedChild.on('error', (err) => onGone(err.message));
  spawnedChild.on('close', (code, sig) => onGone(`code=${code} sig=${sig}`));

  return spawnedChild;
}

/**
 * Send one JSON-RPC call to the helper and await its response.
 * @param {string} method
 * @param {Record<string, unknown>} params
 * @returns {Promise<unknown>}
 */
function callHelper(method, params, context = null) {
  return new Promise((resolve, reject) => {
    let c;
    try {
      c = ensureChild();
    } catch (err) {
      reject(err);
      return;
    }
    const callGeneration = helperGeneration;
    const id = nextId++;
    try {
      helperSupervisor.requestStarted(method, pending.size + 1);
    } catch (err) {
      reject(err);
      return;
    }
    const timeoutMs = resolveHelperCallTimeoutMs(method);
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        runtimeState.noteNativeHelperCallTimeout(callGeneration, method, timeoutMs);
        helperSupervisor.requestFailed(method, pending.size, `timeout:${method}`);
        if (child === c) killNativeHelper(`timeout:${method}`);
        reject(new Error(`native-helper call '${method}' timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    pending.set(id, {
      method,
      resolve(value) {
        helperSupervisor.requestCompleted(method, pending.size);
        resolve(value);
      },
      reject(error) {
        helperSupervisor.requestFailed(
          method,
          pending.size,
          error instanceof Error ? error.message : String(error),
        );
        reject(error);
      },
      timer,
    });
    try {
      c.stdin.write(JSON.stringify({
        id,
        method,
        params,
        ...(context ? { context } : {}),
      }) + '\n');
    } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      helperSupervisor.requestFailed(
        method,
        pending.size,
        err instanceof Error ? err.message : String(err),
      );
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Build the fixed helper request for an allowlisted Electron command.
 * Keeping the health mapping in this pure function makes the security property
 * testable: caller-controlled args can never replace `ping` with an input or
 * accessibility method.
 */
function buildNativeHelperRequest(cmd, args) {
  if (!HELPER_CMDS.has(cmd)) return null;
  if (cmd === 'native_helper_health') return { method: 'health', params: {} };
  let requestArgs = args && typeof args === 'object' ? { ...args } : {};
  if (cmd.startsWith('input_lease_')) {
    const allowedKeys = {
      input_lease_begin: ['leaseId'],
      input_lease_activate: ['leaseId', 'expectedInputEpoch'],
      input_lease_commit_observation: ['leaseId', 'expectedInputEpoch'],
      input_lease_observe: ['leaseId'],
      input_lease_pause: ['leaseId', 'consentOwnerProcessId'],
      input_lease_resume: ['leaseId'],
      input_lease_end: ['leaseId'],
    }[cmd] || [];
    requestArgs = Object.fromEntries(
      allowedKeys
        .filter((key) => Object.hasOwn(requestArgs, key))
        .map((key) => [key, requestArgs[key]]),
    );
  }
  const rawContext = requestArgs[COMPUTER_USE_REQUEST_CONTEXT_ARG];
  delete requestArgs[COMPUTER_USE_REQUEST_CONTEXT_ARG];
  const target = rawContext?.target && typeof rawContext.target === 'object'
    ? {
        app_id: typeof rawContext.target.appId === 'string' ? rawContext.target.appId.slice(0, 1024) : null,
        process_id: Number.isSafeInteger(rawContext.target.processId) ? rawContext.target.processId : null,
        window_id: typeof rawContext.target.windowId === 'string' ? rawContext.target.windowId.slice(0, 128) : null,
      }
    : null;
  const context = rawContext && typeof rawContext === 'object'
    ? {
        conversation_id: typeof rawContext.conversationId === 'string'
          ? rawContext.conversationId.slice(0, 256)
          : null,
        loop_id: typeof rawContext.loopId === 'string' ? rawContext.loopId.slice(0, 256) : null,
        target,
      }
    : null;
  return {
    method: cmd,
    params: toSnakeArgs(requestArgs),
    ...(context ? { context } : {}),
  };
}

function validateHelperHello(value) {
  if (!value || typeof value !== 'object') {
    throw new Error('native-helper compatibility check failed: invalid hello response');
  }
  if (value.protocol_version !== NATIVE_HELPER_PROTOCOL_VERSION) {
    throw new Error(
      `native-helper protocol is incompatible: expected ${NATIVE_HELPER_PROTOCOL_VERSION}, got ${String(value.protocol_version)}`
    );
  }
  if (
    typeof value.binary_version !== 'string'
    || typeof value.platform !== 'string'
    || !Array.isArray(value.supported_commands)
    || !value.supported_commands.every((command) => typeof command === 'string')
    || typeof value.started_at_ms !== 'number'
    || !value.capabilities
    || typeof value.capabilities !== 'object'
    || value.capabilities.transport !== 'ndjson-stdio'
    || value.capabilities.request_serialization !== 'host'
    || value.capabilities.legacy_v1_request_adapter !== true
    || !Array.isArray(value.capabilities.events)
    || !value.capabilities.events.every((event) => typeof event === 'string')
  ) {
    throw new Error('native-helper compatibility check failed: incomplete hello response');
  }
  return value;
}

const DRIVER_IDENTITIES = new Set(['runtime-id', 'session-index', 'none']);
const DRIVER_EMPTY_VALUES = new Set(['string', 'null', 'unknown']);
// Contract §2.8: what the helper process actually got, not what it asked for.
const DRIVER_DPI_AWARENESS = new Set(['per-monitor-v2', 'per-monitor', 'system', 'unaware', 'unknown']);

function helloPlatformToNode(platform) {
  if (platform === 'windows') return 'win32';
  if (platform === 'macos') return 'darwin';
  return platform;
}

/**
 * What the Host assumes about a helper that predates the L3 declaration:
 * nothing is promised beyond what every driver has always had to do.
 */
function legacyDriverCapabilities(platform = process.platform) {
  return deepFreeze({
    id: platform === 'win32' ? 'windows-uia' : platform === 'darwin' ? 'macos-ax' : 'unavailable',
    declared: false,
    input: {
      foreground_required: true,
      background_element_actions: false,
      unicode_text: false,
      clipboard_paste: false,
      chords: true,
      ime_aware: false,
      physical_input_monitoring: false,
    },
    capture: { display: 'unknown', occluded_window: false, excludes_own_window: false, dpi_awareness: 'unknown' },
    elements: { identity: 'session-index', empty_value: 'unknown', actions: [] },
    boundaries: [],
    activation: { can_activate_window: true },
  });
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

const flag = (value) => value === true;
const stringList = (value) => (Array.isArray(value)
  ? value.filter((item) => typeof item === 'string' && item.length <= 64).slice(0, 64)
  : []);

/**
 * L3 driver capability declaration (contract §2.8), read from the hello. A
 * missing or malformed declaration yields the legacy table; a present one is
 * taken field by field with the conservative value for anything unparseable —
 * a driver can only ever under-promise by omission, never over-promise.
 */
function normalizeDriverCapabilities(hello, platform = null) {
  const nodePlatform = platform ?? helloPlatformToNode(hello?.platform) ?? process.platform;
  const raw = hello?.capabilities?.driver;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.id !== 'string' || !raw.id.trim()) {
    return legacyDriverCapabilities(nodePlatform);
  }
  const input = raw.input && typeof raw.input === 'object' ? raw.input : {};
  const capture = raw.capture && typeof raw.capture === 'object' ? raw.capture : {};
  const elements = raw.elements && typeof raw.elements === 'object' ? raw.elements : {};
  const activation = raw.activation && typeof raw.activation === 'object' ? raw.activation : {};
  return deepFreeze({
    id: raw.id.trim().slice(0, 64),
    declared: true,
    input: {
      // Foreground is required unless the driver explicitly says otherwise.
      foreground_required: input.foreground_required !== false,
      background_element_actions: flag(input.background_element_actions),
      unicode_text: flag(input.unicode_text),
      clipboard_paste: flag(input.clipboard_paste),
      chords: flag(input.chords),
      ime_aware: flag(input.ime_aware),
      physical_input_monitoring: flag(input.physical_input_monitoring),
    },
    capture: {
      display: typeof capture.display === 'string' && capture.display ? capture.display.slice(0, 64) : 'unknown',
      occluded_window: flag(capture.occluded_window),
      excludes_own_window: flag(capture.excludes_own_window),
      dpi_awareness: DRIVER_DPI_AWARENESS.has(capture.dpi_awareness) ? capture.dpi_awareness : 'unknown',
    },
    elements: {
      identity: DRIVER_IDENTITIES.has(elements.identity) ? elements.identity : 'session-index',
      empty_value: DRIVER_EMPTY_VALUES.has(elements.empty_value) ? elements.empty_value : 'unknown',
      actions: stringList(elements.actions),
    },
    boundaries: stringList(raw.boundaries),
    activation: {
      can_activate_window: activation.can_activate_window !== false,
    },
  });
}

/** Declaration of the running helper; null until the handshake completes. */
function getNativeHelperDriverCapabilities() {
  return lastDriverCapabilities;
}

async function ensureHelperCompatibility() {
  if (!helperHandshake) {
    helperHandshake = callHelper('hello', {})
      .then((value) => {
        const hello = validateHelperHello(value);
        lastDriverCapabilities = normalizeDriverCapabilities(hello);
        helperSupervisor.ready(helperGeneration);
        runtimeState.noteNativeHelperReady(helperGeneration, hello);
        return hello;
      })
      .catch((error) => {
        helperSupervisor.failed(
          helperGeneration,
          error instanceof Error ? error.message : String(error),
        );
        runtimeState.noteNativeHelperSpawnFailed(
          helperGeneration,
          error instanceof Error ? error.name : typeof error,
        );
        helperHandshake = null;
        throw error;
      });
  }
  return helperHandshake;
}

/**
 * Dispatch a `tauri:invoke` command to the native-helper if it owns it.
 * @param {string} cmd
 * @param {Record<string, unknown>} args
 * @returns {Promise<unknown> | typeof NATIVE_HELPER_MISS}
 */
function nativeHelperDispatch(cmd, args) {
  const request = buildNativeHelperRequest(cmd, args);
  if (!request) return NATIVE_HELPER_MISS;
  return requestScheduler.run(async () => {
    const hello = await ensureHelperCompatibility();
    if (!hello.supported_commands.includes(request.method)) {
      throw new Error(
        `native-helper ${hello.binary_version} does not support '${request.method}'`
      );
    }
    const result = await callHelper(request.method, request.params, request.context);
    if (cmd === 'native_helper_health' && result && typeof result === 'object') {
      return { ...result, supervisor: helperSupervisor.snapshot() };
    }
    return result;
  });
}

/** Kill the helper child (called on app quit; no orphans). */
function killNativeHelper(reason = 'stopped') {
  requestScheduler.invalidate();
  const stoppedChild = child;
  if (stoppedChild) {
    helperSupervisor.resetting(reason);
    runtimeState.noteNativeHelperStopped(helperGeneration, reason);
    child = null;
    helperHandshake = null;
    lastDriverCapabilities = null;
    helperGeneration += 1;
    rejectAllPending(new Error(
      `native-helper was stopped (${reason}); a fresh Computer Use observation is required`
    ));
  }
  if (stoppedChild && !stoppedChild.killed) {
    try {
      stoppedChild.kill('SIGKILL');
    } catch {
      /* already dead */
    }
  }
  helperSupervisor.stopped(helperGeneration, reason);
}

function subscribeNativeHelperEvents(listener) {
  if (typeof listener !== 'function') {
    throw new TypeError('native-helper event listener must be a function');
  }
  helperEventListeners.add(listener);
  return () => helperEventListeners.delete(listener);
}

function getNativeHelperGeneration() {
  return helperGeneration;
}

function getNativeHelperSupervisorSnapshot() {
  return helperSupervisor.snapshot();
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
  normalizeHelperError,
  normalizeDriverCapabilities,
  legacyDriverCapabilities,
  getNativeHelperDriverCapabilities,
  HELPER_EXECUTIONS,
  NATIVE_HELPER_MISS,
  killNativeHelper,
  getNativeHelperGeneration,
  getNativeHelperSupervisorSnapshot,
  callHelper,
  HELPER_CMDS,
  nativeHelperExecutableName,
  resolveHelperPath,
  buildNativeHelperRequest,
  validateHelperHello,
  resolveHelperCallTimeoutMs,
  normalizeHelperEvent,
  createSerialExecutor,
  createNativeHelperSupervisorState,
  HELPER_SUPERVISOR_STATES,
  subscribeNativeHelperEvents,
  NATIVE_HELPER_PROTOCOL_VERSION,
  DEFAULT_CALL_TIMEOUT_MS,
  OBSERVATION_CALL_TIMEOUT_MS,
};
