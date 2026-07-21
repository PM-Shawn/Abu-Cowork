/**
 * Sidecar Manager — P1-0 process-split skeleton supervisor.
 *
 * Context: step 1 of extracting the agent loop into a headless Node sidecar
 * process (design: docs/2026-07-19-phase1-process-split-design.md §1, §2,
 * §5 "P1-0"). In P1-0 the sidecar (`sidecar/index.mjs`) is an idle
 * newline-delimited-JSON JSON-RPC 2.0 echo/ping skeleton — it does NOT carry
 * any product behavior yet. This module is the shell-side supervisor: spawn
 * it, talk JSON-RPC to it over stdio, and keep it alive.
 *
 * It reuses the existing generic process bridge (`mcp_spawn` / `mcp_write` /
 * `mcp_kill` in src-tauri/src/lib.rs, already used by src/core/mcp/client.ts
 * for MCP stdio servers) instead of adding new Rust commands. That bridge's
 * PATH construction already appends the bundled Node runtime as a fallback,
 * so spawning the literal command `'node'` resolves even on machines with no
 * system Node install.
 *
 * ZERO product behavior depends on this today — every failure path here
 * MUST be fail-soft: log a warning and move on. Nothing in this module may
 * throw out of `startSidecar()` / `stopSidecar()`, and nothing here may
 * surface an error to the UI.
 *
 * ## Restart policy (documented per P1-0 spec)
 *
 * A single fixed process id (`abu-sidecar`) is reused across the sidecar's
 * entire lifetime — including every restart — rather than minting a new id
 * per spawn attempt (unlike `TauriStdioTransport` in mcp/client.ts, which
 * mints a unique id per MCP server connection). This lets Tauri event
 * listeners (`mcp-msg-*` / `mcp-err-*` / `mcp-close-*`) be registered ONCE
 * and reused across restarts, but it also means Rust's process table keeps a
 * dead child's entry around until `mcp_kill` is explicitly called (it does
 * not self-clean on unexpected exit) — so every spawn attempt, including the
 * very first one, is preceded by a defensive (best-effort, errors ignored)
 * `mcp_kill` to clear any stale entry before calling `mcp_spawn`.
 *
 * ANY failure — the initial spawn's `invoke('mcp_spawn')` rejecting, an
 * unexpected `mcp-close-abu-sidecar` event, or 3 consecutive heartbeat ping
 * timeouts — is treated identically by `scheduleRestartOrGiveUp()`: it counts
 * as one entry in a rolling 60s window, and unless that window already holds
 * more than `CRASH_LOOP_MAX_RESTARTS` (3) entries, it schedules exactly one
 * respawn attempt (after a small fixed backoff, `RESTART_BACKOFF_MS`, to
 * avoid a tight spawn loop). Once the window exceeds the threshold, the
 * supervisor gives up: status becomes `'failed'`, a single warning is
 * logged, and no further spawn attempts are made until `startSidecar()` is
 * called again from a clean/failed state.
 *
 * This means a spawn failure on the very first `startSidecar()` call does
 * NOT immediately land on `'failed'` — it is retried (as a "restart") up to
 * 3 more times within the 60s window before the supervisor gives up. Callers
 * never see this as a rejected promise: `startSidecar()` always resolves
 * once the first attempt concludes (success or handed off to the internal
 * retry scheduler); check `getSidecarStatus()` for the eventual outcome.
 *
 * ## Known limitation — stale close-event race
 *
 * Because `mcp-close-abu-sidecar` is a single shared event name reused
 * across every spawn generation, a close event from a process we just
 * force-killed ourselves (heartbeat-hang restart, or the defensive
 * pre-spawn kill) *could* theoretically arrive at the JS side after we've
 * already respawned and observed `status === 'running'` again, and be
 * misread as a fresh unexpected close. This is mitigated by ignoring close
 * events while `status` is `'starting'` or `'restarting'` (i.e. while a kill
 * we just issued is still in flight) or already `'stopped'`/`'failed'`. A
 * stale event arriving *after* that window closes would incorrectly trigger
 * one extra restart — self-healing (the crash-loop guard bounds the damage,
 * and the next heartbeat cycle re-validates real health). Exact
 * correlation would require tagging close events with a spawn generation on
 * the Rust side, which is out of scope for P1-0 (no Rust changes allowed).
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { resolveResource, appDataDir, resourceDir } from '@tauri-apps/api/path';
import { isTauriEnv } from '@/utils/tauriEnv';
import { createLogger } from '@/core/logging/logger';

const logger = createLogger('sidecar');

/** Fixed id shared by every spawn attempt — see module JSDoc "Restart policy". */
const SIDECAR_ID = 'abu-sidecar';

const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 5_000;
const HEARTBEAT_FAILURE_THRESHOLD = 3;
const REQUEST_DEFAULT_TIMEOUT_MS = 5_000;
const CRASH_LOOP_WINDOW_MS = 60_000;
const CRASH_LOOP_MAX_RESTARTS = 3;
/** Small fixed delay before a respawn attempt, to avoid a tight spawn loop. */
const RESTART_BACKOFF_MS = 500;

export type SidecarStatus = 'stopped' | 'starting' | 'running' | 'restarting' | 'failed';

interface JSONRPCResponse {
  jsonrpc?: '2.0';
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  /** null when the request was sent with timeoutMs: 0 ("no timeout" — see request() JSDoc). */
  timer: ReturnType<typeof setTimeout> | null;
}

/** Handler for a sidecar→shell JSON-RPC notification (message with `method`, no `id`). */
export type SidecarNotificationHandler = (params: unknown) => void;

/**
 * Handler for a sidecar→shell JSON-RPC REQUEST (message with `method` AND
 * `id`) — the reverse direction of `request()`. Return the result (sent back
 * as `{ result }`); throw to send back `{ error }` (see `handleIncomingRequest`
 * for the throw→error-code mapping). Registered once per method via
 * `onSidecarRequest()` — P1-3a's `tool.invoke` / `hook.emit` reverse channel
 * (subagentRunner.ts) is the first consumer.
 */
export type SidecarRequestHandler = (params: unknown) => Promise<unknown>;

/**
 * Error type a `SidecarRequestHandler` can throw to control the JSON-RPC
 * error code/data sent back to the sidecar (mirrors `RpcError` on the
 * sidecar's own side — see sidecar/src/protocol.ts). Anything else thrown
 * collapses to the generic -32000 with just a message.
 */
export class SidecarRequestError extends Error {
  code: number;
  data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'SidecarRequestError';
    this.code = code;
    this.data = data;
  }
}

/**
 * Rejection error for a request() call whose response carried a JSON-RPC
 * `error` member. Carries the raw `code`/`data` through (unlike a plain
 * Error, which would lose them) so callers — notably
 * `src/core/llm/sidecarAdapter.ts` — can reconstruct a faithful `LLMError`
 * from `sidecar/src/llmHost.ts`'s `errorDataFor()` payload instead of only
 * seeing a flattened message string.
 */
export class SidecarRpcError extends Error {
  code: number;
  data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(`Sidecar error ${code}: ${message}`);
    this.name = 'SidecarRpcError';
    this.code = code;
    this.data = data;
  }
}

// ── Module state (module-scope singleton — one sidecar per app instance) ──

let status: SidecarStatus = 'stopped';
let listenersReady = false;
let unlisteners: UnlistenFn[] = [];
let deliberatelyStopped = true;
let startPromise: Promise<void> | null = null;
let nextRequestId = 1;
const pendingRequests = new Map<number, PendingRequest>();

/** method -> handlers, for sidecar→shell notifications (llm.event, llm.chatMeta, ...). See onSidecarNotification(). */
const notificationHandlers = new Map<string, Set<SidecarNotificationHandler>>();

/** method -> handler, for sidecar→shell REQUESTS (tool.invoke, hook.emit, ...). See onSidecarRequest(). Single handler per method (unlike notifications' Set) — a request needs exactly one response. */
const requestHandlers = new Map<string, SidecarRequestHandler>();

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatFailures = 0;

/** Rolling window of restart timestamps — see "Restart policy" in module JSDoc. */
let restartTimestamps: number[] = [];
let crashLoopWarned = false;

// ── Public API ──

/** Current supervisor state. Exported for future use/tests. */
export function getSidecarStatus(): SidecarStatus {
  return status;
}

/**
 * Start the sidecar. Idempotent — a call while already `'starting'`,
 * `'running'`, or mid-`'restarting'` is a no-op. Never throws: every
 * failure is caught, logged, and handled by the restart policy (see module
 * JSDoc) so the rest of the app starts up exactly as if this were absent.
 */
export async function startSidecar(): Promise<void> {
  if (!isTauriEnv()) return; // web/E2E: no Tauri process bridge available

  if (status === 'starting' || status === 'running' || status === 'restarting') {
    return; // already active, or a restart is already in flight
  }

  deliberatelyStopped = false;
  crashLoopWarned = false;
  restartTimestamps = [];

  const attempt = attemptSpawn('initial');
  startPromise = attempt.finally(() => {
    startPromise = null;
  });
  await startPromise;
}

/**
 * Deliberate stop: clears timers, unregisters all Tauri event listeners,
 * kills the process via the bridge, and sets status to `'stopped'`. Used by
 * tests today; will also back a future "sidecar off" toggle.
 */
export async function stopSidecar(): Promise<void> {
  deliberatelyStopped = true;
  stopHeartbeat();
  rejectAllPending(new Error('Sidecar stopped'));
  restartTimestamps = [];
  crashLoopWarned = false;
  status = 'stopped';

  for (const unlisten of unlisteners) {
    unlisten();
  }
  unlisteners = [];
  listenersReady = false;

  try {
    await invoke('mcp_kill', { id: SIDECAR_ID });
  } catch (err) {
    logger.warn('Sidecar mcp_kill failed during stop', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Send a JSON-RPC request over the bridge and resolve/reject on the
 * correlated response (matched by numeric id) or timeout. Used internally
 * for the heartbeat ping and the post-spawn self-test echo; exported so
 * tests can exercise request/response correlation directly, and for real
 * sidecar calls (e.g. `llm.chat`) routed through this transport.
 *
 * `timeoutMs: 0` means NO timeout — used by `llm.chat`, whose response only
 * settles once an entire (potentially multi-minute) streaming call
 * completes; hang protection for that case lives in the adapters' own
 * heartbeat/idle-timeout machinery (see src/core/llm/heartbeat.ts), not
 * here. Pending requests sent with timeoutMs: 0 still reject like any other
 * pending request when the sidecar process closes (rejectAllPending, called
 * from handleClose()) — they are not immune to that.
 */
export function request(
  method: string,
  params: unknown,
  timeoutMs: number = REQUEST_DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  const id = nextRequestId++;
  const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });

  return new Promise<unknown>((resolve, reject) => {
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          pendingRequests.delete(id);
          reject(new Error(`Sidecar request "${method}" timed out after ${timeoutMs}ms`));
        }, timeoutMs)
      : null;

    pendingRequests.set(id, { resolve, reject, timer });

    invoke('mcp_write', { id: SIDECAR_ID, message: payload }).catch((err: unknown) => {
      const entry = pendingRequests.get(id);
      if (entry) {
        if (entry.timer) clearTimeout(entry.timer);
        pendingRequests.delete(id);
      }
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

/**
 * Send a JSON-RPC notification (no `id`, no response expected) to the
 * sidecar — e.g. `llm.abort`. Fire-and-forget: failures are logged, not
 * thrown, matching the rest of this module's fail-soft contract.
 */
export function notifySidecar(method: string, params: unknown): void {
  const payload = JSON.stringify({ jsonrpc: '2.0', method, params });
  invoke('mcp_write', { id: SIDECAR_ID, message: payload }).catch((err: unknown) => {
    logger.warn('Sidecar notify failed', {
      method,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * Subscribe to a sidecar→shell JSON-RPC notification (`llm.event`,
 * `llm.chatMeta`, ...) — messages with a `method` and no `id`. Returns an
 * unsubscribe function. Multiple handlers per method are supported (Set).
 */
export function onSidecarNotification(method: string, handler: SidecarNotificationHandler): () => void {
  let handlers = notificationHandlers.get(method);
  if (!handlers) {
    handlers = new Set();
    notificationHandlers.set(method, handlers);
  }
  handlers.add(handler);
  return () => {
    const current = notificationHandlers.get(method);
    if (!current) return;
    current.delete(handler);
    if (current.size === 0) notificationHandlers.delete(method);
  };
}

/**
 * Register the (single) handler for a sidecar→shell JSON-RPC REQUEST method
 * — the reverse direction of `request()`. Only one handler per method (a
 * request needs exactly one response; unlike notifications there is no
 * fan-out). Registering a second handler for the same method replaces the
 * first — callers that need "register once at module init" discipline
 * (subagentRunner.ts) are responsible for that themselves (idempotent guard).
 * Returns an unsubscribe function that removes the handler IF it is still
 * the currently-registered one (a stale unsubscribe after a replacement
 * won't clobber the new handler).
 */
export function onSidecarRequest(method: string, handler: SidecarRequestHandler): () => void {
  requestHandlers.set(method, handler);
  return () => {
    if (requestHandlers.get(method) === handler) {
      requestHandlers.delete(method);
    }
  };
}

/** Reset all module state for test isolation. Not used by production code. */
export function __resetForTests(): void {
  status = 'stopped';
  listenersReady = false;
  unlisteners = [];
  deliberatelyStopped = true;
  startPromise = null;
  nextRequestId = 1;
  for (const entry of pendingRequests.values()) {
    if (entry.timer) clearTimeout(entry.timer);
  }
  pendingRequests.clear();
  notificationHandlers.clear();
  requestHandlers.clear();
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  heartbeatFailures = 0;
  restartTimestamps = [];
  crashLoopWarned = false;
}

// ── Spawn / restart machinery ──

async function ensureListeners(): Promise<void> {
  if (listenersReady) return;
  listenersReady = true;

  const unlistenMsg = await listen<string>(`mcp-msg-${SIDECAR_ID}`, (event) => {
    handleMessage(event.payload);
  });
  const unlistenErr = await listen<string>(`mcp-err-${SIDECAR_ID}`, (event) => {
    // B1 (P1-3d follow-up): sidecar stderr used to be logged at `debug`, i.e.
    // invisible in dev — so EVERY sidecar-internal diagnostic (the memory
    // extractor's `[Memory] …`, any uncaught runtime error, a stray
    // console.log the stdout-guard redirects here) silently vanished. That's
    // the observability gap that made 3d-2's runtime verification impossible.
    // The sidecar logger shim tags each line `[sidecar:mod] [level] …`; route
    // to the matching shell level so real sidecar warn/error surface. An
    // UNTAGGED line (redirected console.log, or a raw thrown error with no
    // level) is surfaced at `warn` — better loud than lost.
    const line = event.payload;
    const level = /\]\s*\[(debug|info|warn|error)\]/.exec(line)?.[1];
    if (level === 'debug') logger.debug('Sidecar stderr', { line });
    else if (level === 'info') logger.info('Sidecar stderr', { line });
    else if (level === 'error') logger.error('Sidecar stderr', { line });
    else logger.warn('Sidecar stderr', { line });
  });
  const unlistenClose = await listen<string>(`mcp-close-${SIDECAR_ID}`, () => {
    handleClose();
  });

  unlisteners = [unlistenMsg, unlistenErr, unlistenClose];
}

async function attemptSpawn(kind: 'initial' | 'restart'): Promise<void> {
  status = kind === 'initial' ? 'starting' : 'restarting';

  // Listeners must be live before we spawn, so we never miss an early
  // stdout line or an immediate crash.
  await ensureListeners();

  // Defensive: clear any stale process table entry (see "Restart policy" in
  // module JSDoc). No-op — and emits no close event — if nothing was there.
  await invoke('mcp_kill', { id: SIDECAR_ID }).catch(() => {});

  let entryPath: string;
  try {
    entryPath = await resolveResource('sidecar/index.mjs');
  } catch (err) {
    handleSpawnFailure(err, 'resolve-resource-failed');
    return;
  }

  // Bootstrap env vars for sidecar/src/bootstrap.ts — the two Tauri-only
  // directories a plain Node process can't derive itself (appDataDir depends
  // on the app's bundle identifier; resourceDir depends on Tauri's
  // dev-vs-packaged resource resolution). Passed as spawn-time env vars
  // (available synchronously via process.env from the sidecar's very first
  // line — no post-spawn race) rather than a notification; see
  // bootstrap.ts's module doc for the full rationale. Best-effort per this
  // module's own "every failure path MUST be fail-soft" rule: a resolution
  // failure here is logged and the var is simply omitted, never fails the
  // spawn — nothing in the sidecar's CURRENT role depends on these yet.
  const spawnEnv: Record<string, string> = {};
  try {
    spawnEnv.ABU_APP_DATA_DIR = await appDataDir();
  } catch (err) {
    logger.warn('Failed to resolve appDataDir for sidecar bootstrap', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    spawnEnv.ABU_RESOURCE_DIR = await resourceDir();
  } catch (err) {
    logger.warn('Failed to resolve resourceDir for sidecar bootstrap', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    await invoke('mcp_spawn', { id: SIDECAR_ID, command: 'node', args: [entryPath], env: spawnEnv });
  } catch (err) {
    handleSpawnFailure(err, 'spawn-failed');
    return;
  }

  status = 'running';
  startHeartbeat();
  void selfTestEcho();
}

function handleSpawnFailure(err: unknown, reason: string): void {
  logger.warn('Sidecar spawn failed', {
    reason,
    error: err instanceof Error ? err.message : String(err),
  });
  scheduleRestartOrGiveUp(reason);
}

/**
 * Central restart decision point — see "Restart policy" in the module
 * JSDoc. Called on any failure (spawn error, unexpected close, heartbeat
 * hang). Either schedules exactly one respawn attempt, or gives up.
 */
function scheduleRestartOrGiveUp(reason: string): void {
  if (deliberatelyStopped) {
    status = 'stopped';
    return;
  }

  const now = Date.now();
  restartTimestamps.push(now);
  restartTimestamps = restartTimestamps.filter((t) => now - t <= CRASH_LOOP_WINDOW_MS);

  if (restartTimestamps.length > CRASH_LOOP_MAX_RESTARTS) {
    status = 'failed';
    if (!crashLoopWarned) {
      crashLoopWarned = true;
      logger.warn('Sidecar crash-looped — giving up', {
        reason,
        restartsInWindow: restartTimestamps.length,
        windowMs: CRASH_LOOP_WINDOW_MS,
      });
    }
    return;
  }

  status = 'restarting';
  logger.warn('Sidecar restarting', { reason, attempt: restartTimestamps.length });
  setTimeout(() => {
    void attemptSpawn('restart');
  }, RESTART_BACKOFF_MS);
}

async function selfTestEcho(): Promise<void> {
  const start = Date.now();
  try {
    await request('echo', { selfTest: true }, REQUEST_DEFAULT_TIMEOUT_MS);
    logger.debug('Sidecar self-test echo round-trip', { latencyMs: Date.now() - start });
  } catch (err) {
    logger.warn('Sidecar self-test echo failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Heartbeat ──

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatFailures = 0;
  heartbeatTimer = setInterval(() => {
    void runHeartbeat();
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

async function runHeartbeat(): Promise<void> {
  if (status !== 'running') return;
  try {
    await request('ping', undefined, HEARTBEAT_TIMEOUT_MS);
    heartbeatFailures = 0;
  } catch (err) {
    heartbeatFailures += 1;
    if (heartbeatFailures < HEARTBEAT_FAILURE_THRESHOLD) {
      logger.warn('Sidecar heartbeat failed', {
        failures: heartbeatFailures,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    logger.warn('Sidecar heartbeat threshold exceeded — forcing restart', {
      failures: heartbeatFailures,
    });
    heartbeatFailures = 0;
    stopHeartbeat();
    // Flip to 'restarting' BEFORE killing, so the close event this kill
    // triggers is recognized as self-initiated by handleClose() below.
    status = 'restarting';
    await invoke('mcp_kill', { id: SIDECAR_ID }).catch(() => {});
    scheduleRestartOrGiveUp('heartbeat-hung');
  }
}

// ── Event handlers ──

function handleMessage(raw: string): void {
  let msg: JSONRPCResponse;
  try {
    msg = JSON.parse(raw) as JSONRPCResponse;
  } catch {
    logger.warn('Sidecar sent malformed message on stdout', { raw });
    return;
  }

  // Incoming REQUEST *from* the sidecar (has `method` AND `id`) — the
  // reverse direction of request()/onSidecarRequest(). Discriminated BEFORE
  // the notification check below so it takes priority when both `method`
  // and `id` are present. Sidecar-minted ids are STRINGS ('sq-N' —
  // sidecar/src/protocol.ts's outbound-request id scheme); our own outbound
  // request ids (nextRequestId, below) are NUMBERS — the two id spaces are
  // disjoint by construction, so a string id here can never collide with a
  // response to a request we sent (the response-correlation branch further
  // below only matches `typeof msg.id === 'number'`).
  if (typeof msg.method === 'string' && msg.id !== undefined) {
    void handleIncomingRequest(msg.method, msg.id, msg.params);
    return;
  }

  // Notification (has `method`, no `id`) — e.g. llm.event / llm.chatMeta.
  // Dispatch to subscribers registered via onSidecarNotification(); drop
  // silently if nobody is listening for this method.
  if (typeof msg.method === 'string' && msg.id === undefined) {
    const handlers = notificationHandlers.get(msg.method);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(msg.params);
        } catch (err) {
          logger.warn('Sidecar notification handler threw', {
            method: msg.method,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    return;
  }

  if (typeof msg.id !== 'number') return; // not a response to a request we sent

  const entry = pendingRequests.get(msg.id);
  if (!entry) return; // no matching pending request (late/duplicate) — ignore

  if (entry.timer) clearTimeout(entry.timer);
  pendingRequests.delete(msg.id);

  if (msg.error) {
    entry.reject(new SidecarRpcError(msg.error.code, msg.error.message, msg.error.data));
  } else {
    entry.resolve(msg.result);
  }
}

/**
 * Dispatch one incoming request from the sidecar to its registered handler
 * and write the JSON-RPC response back over the same `mcp_write` pipe.
 * Unknown method → -32601 (mirrors sidecar/src/main.ts's own unknown-method
 * handling for symmetry). Handler throw → -32000, carrying `.data` through
 * if the thrown error has one (mirrors sidecar/src/protocol.ts's `RpcError`
 * / `errorFromCaught` convention on the other side of the pipe).
 */
async function handleIncomingRequest(
  method: string,
  id: string | number | null,
  params: unknown,
): Promise<void> {
  const handler = requestHandlers.get(method);
  if (!handler) {
    await writeRpcMessage({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    return;
  }

  try {
    const result = await handler(params);
    await writeRpcMessage({ jsonrpc: '2.0', id, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const data = err instanceof SidecarRequestError ? err.data : undefined;
    const code = err instanceof SidecarRequestError ? err.code : -32000;
    await writeRpcMessage({
      jsonrpc: '2.0',
      id,
      error: data !== undefined ? { code, message, data } : { code, message },
    });
  }
}

/** Write one JSON-RPC message (a response to an incoming sidecar request) back over the pipe. Fail-soft — logs, never throws. */
async function writeRpcMessage(payload: unknown): Promise<void> {
  try {
    await invoke('mcp_write', { id: SIDECAR_ID, message: JSON.stringify(payload) });
  } catch (err) {
    logger.warn('Failed to write response to an incoming sidecar request', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function handleClose(): void {
  stopHeartbeat();
  rejectAllPending(new Error('Sidecar process closed'));

  if (deliberatelyStopped) {
    status = 'stopped';
    return;
  }

  if (status === 'starting' || status === 'restarting' || status === 'failed') {
    // Echo of a kill we just issued ourselves (defensive pre-spawn kill or
    // heartbeat-hang forced kill), or we've already given up — don't
    // double-count this as a new failure. See "Known limitation" in the
    // module JSDoc for the residual race this doesn't fully close.
    return;
  }

  scheduleRestartOrGiveUp('close');
}

function rejectAllPending(err: Error): void {
  for (const entry of pendingRequests.values()) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.reject(err);
  }
  pendingRequests.clear();
}
