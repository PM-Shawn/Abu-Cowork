/**
 * Electron main-side generic child-process bridge (Phase 2 — mcp 收敛).
 *
 * Faithful port of Tauri's `mcp_spawn`/`mcp_write`/`mcp_kill` (src-tauri/src/
 * lib.rs) — a GENERIC stdio process bridge the frontend uses for BOTH MCP
 * stdio servers (src/core/mcp/client.ts) AND the agent sidecar
 * (src/core/sidecar/sidecarManager.ts). The renderer owns the JSON-RPC /
 * supervision on top; main just spawns, pipes stdin, and re-emits stdout/
 * stderr/close as `mcp-msg-{id}` / `mcp-err-{id}` / `mcp-close-{id}` events
 * (delivered via the slice-B event bridge to the frontend's
 * `listen('mcp-msg-{id}', …)`), exactly like the Rust bridge.
 *
 * Protocol notes (matching Tauri):
 *  - stdout AND stderr are line-framed (persistent per-stream buffer) — one
 *    event per '\n' line, so a line split across chunks isn't fragmented.
 *  - mcp_write appends '\n' (the frontend sends a bare JSON line).
 *  - `command: 'node'` runs Electron's bundled Node via ELECTRON_RUN_AS_NODE.
 *  - Other commands (npx/python/uvx/…) get a login-shell PATH so they resolve
 *    even when the app is launched from Finder with a minimal PATH (Rust used
 *    get_login_shell_path for the same reason).
 *  - mcp_spawn REJECTS on spawn failure (ENOENT) and REJECTS if a live process
 *    already holds the id (never tears down the existing one) — matching Rust.
 *  - Exactly one `mcp-close-{id}` per process; none on a spawn-phase failure
 *    (the rejected invoke is that signal).
 *
 * No-orphan: SIGINT/SIGTERM/SIGHUP + 'exit' guards kill every spawned child
 * (main no longer runs the SidecarSupervisor, so this bridge owns the net).
 *
 * ## Main-process liveness heartbeat (F1, opt-in via `mcp_spawn({ heartbeat: true })`)
 *
 * This used to live on the RENDERER side (sidecarManager.ts's `runHeartbeat`)
 * — but the renderer's event loop can stall under heavy rendering, which
 * makes a perfectly healthy sidecar's ping "time out" and triggers a false
 * restart storm. Every competitor (WorkBuddy, Cursor, ChatGPT/Codex, TRAE)
 * supervises liveness from the process that owns the child's stdio, never
 * from a UI thread — so this pings from HERE instead, where a busy renderer
 * can't interfere. Passing `heartbeat: true` in `mcp_spawn`'s args opts a
 * given child into this monitor; every other mcp_spawn caller (plain MCP
 * stdio servers via src/core/mcp/client.ts) is completely unaffected.
 *
 * On 3 consecutive missed pings, main emits `mcp-hung-{id}` (a NEW event,
 * parallel to `mcp-close-{id}`) — the renderer's sidecarManager.ts listens
 * for it and runs its existing force-restart path. Genuine process death is
 * still caught by `mcp-close-{id}` (unchanged); the heartbeat only detects
 * "alive but unresponsive" (e.g. an event-loop deadlock in the child).
 *
 * The ping/ack travels over the SAME stdin/stdout pipe as real JSON-RPC
 * traffic, tagged with a `__mcphb-{seq}` string id so it can never collide
 * with a real request/response: real ids sent by this bridge's callers are
 * always numeric (or string ids minted by the child itself, per its own
 * protocol — see the interception guard in the stdout loop below for why
 * that still can't collide).
 */
'use strict';

const { spawn, execFileSync } = require('node:child_process');

/** id -> ChildProcess */
const children = new Map();

const MCP_CMDS = new Set(['mcp_spawn', 'mcp_write', 'mcp_kill']);

// Heartbeat constants — mirror sidecarManager.ts's former (now-removed)
// HEARTBEAT_INTERVAL_MS/HEARTBEAT_TIMEOUT_MS/HEARTBEAT_FAILURE_THRESHOLD/
// HEARTBEAT_JANK_MARGIN_MS, moved here verbatim (F1).
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 5_000;
const HEARTBEAT_FAILURE_THRESHOLD = 3;
// Belt-and-suspenders: main's own event loop can in theory stall too (a sync
// fs call, a big GC pause). If a ping's timeout fires much later than
// HEARTBEAT_TIMEOUT_MS after it was sent, that lateness itself means the
// verdict is inconclusive (the timer was delayed, not necessarily the
// child) — treat it as a no-op tick rather than a counted failure, so a
// transient main-side stall can't force-kill a healthy child. See
// sidecarManager.ts's former runHeartbeat() for the identical reasoning this
// mirrors (now applied one level down, to main's own clock instead of the
// renderer's).
const HEARTBEAT_JANK_MARGIN_MS = 5_000;

/**
 * id -> heartbeat monitor state. Only populated for children spawned with
 * `heartbeat: true`; absent for every other mcp_spawn caller (MCP stdio
 * servers), which get zero heartbeat behavior — same as before this change.
 * @type {Map<string, {
 *   intervalTimer: ReturnType<typeof setInterval>,
 *   timeoutTimer: ReturnType<typeof setTimeout> | null,
 *   seq: number,
 *   pendingId: string | null,
 *   pendingStart: number,
 *   failures: number,
 * }>}
 */
const heartbeats = new Map();

/** Start the per-child ping loop. No-op if one is already running for `id` (defensive). */
function startHeartbeatMonitor(id) {
  stopHeartbeatMonitor(id);
  const state = {
    intervalTimer: setInterval(() => sendHeartbeatPing(id), HEARTBEAT_INTERVAL_MS),
    timeoutTimer: null,
    seq: 0,
    pendingId: null,
    pendingStart: 0,
    failures: 0,
  };
  heartbeats.set(id, state);
}

/** Clear the interval + any in-flight timeout and drop `id`'s heartbeat state. */
function stopHeartbeatMonitor(id) {
  const state = heartbeats.get(id);
  if (!state) return;
  clearInterval(state.intervalTimer);
  if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
  heartbeats.delete(id);
}

/** One tick of the heartbeat loop: send a ping unless one is already outstanding. */
function sendHeartbeatPing(id) {
  const state = heartbeats.get(id);
  const child = children.get(id);
  if (!state || !child || !child.stdin || !child.stdin.writable) return;
  if (state.pendingId !== null) return; // previous ping still outstanding — skip this tick

  state.seq += 1;
  const pingId = `__mcphb-${state.seq}`;
  state.pendingId = pingId;
  // Monotonic clock (see HEARTBEAT_JANK_MARGIN_MS comment) — a wall-clock
  // step must not be misread as elapsed time.
  state.pendingStart = performance.now();

  try {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: pingId, method: 'ping' }) + '\n');
  } catch {
    // Write failure surfaces the same way silence does: the timeout below
    // still fires and counts it as a missed ping.
  }

  state.timeoutTimer = setTimeout(() => onHeartbeatTimeout(id), HEARTBEAT_TIMEOUT_MS);
}

/**
 * Fires when a ping's ack didn't arrive within HEARTBEAT_TIMEOUT_MS. Decides
 * inconclusive-vs-real-failure (see HEARTBEAT_JANK_MARGIN_MS), and on
 * HEARTBEAT_FAILURE_THRESHOLD consecutive real failures emits `mcp-hung-{id}`.
 */
function onHeartbeatTimeout(id) {
  const state = heartbeats.get(id);
  if (!state) return;
  const elapsed = performance.now() - state.pendingStart;
  state.pendingId = null;
  state.timeoutTimer = null;

  if (elapsed > HEARTBEAT_TIMEOUT_MS + HEARTBEAT_JANK_MARGIN_MS) {
    // Inconclusive — main's own loop was stalled past the margin, so this
    // tick can't tell us anything about the child. Reset rather than count,
    // same rationale as the renderer-side guard this replaces.
    state.failures = 0;
    return;
  }

  state.failures += 1;
  if (state.failures >= HEARTBEAT_FAILURE_THRESHOLD) {
    state.failures = 0;
    emit(`mcp-hung-${id}`, '');
  }
}

/**
 * Called from the stdout line loop BEFORE `emit('mcp-msg-{id}', line)`.
 * Returns true iff `line` was this child's outstanding heartbeat ack (in
 * which case the caller must NOT emit it as a regular message). Guarded:
 * only lines that literally contain `__mcphb-` are even parsed, and any
 * parse failure falls through to a normal emit — a real JSON-RPC response
 * always carries a NUMERIC id (this bridge's own request ids) or a
 * child-minted string id from ITS OWN protocol, neither of which is ever the
 * literal string `__mcphb-{seq}`, so this can never swallow a real response.
 */
function consumeHeartbeatAck(id, line) {
  const state = heartbeats.get(id);
  if (!state || state.pendingId === null) return false;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return false;
  }
  if (parsed && parsed.id === state.pendingId) {
    if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
    state.timeoutTimer = null;
    state.pendingId = null;
    state.failures = 0;
    return true;
  }
  return false;
}

/** Cache the event-bridge emit after the first require (hot path: one call per stream line). */
let _emitEvent = null;
function emit(event, payload) {
  if (!_emitEvent) _emitEvent = require('./tauriHost.cjs').emitEvent;
  _emitEvent(event, payload);
}

/**
 * The user's real login-shell PATH — an Electron app launched from Finder gets
 * a minimal PATH (/usr/bin:/bin:…, no Homebrew/nvm), so npx/python/uvx MCP
 * servers ENOENT. Resolve it once via the login shell (Rust did the same).
 */
let _loginPath = null;
function loginShellPath() {
  if (_loginPath !== null) return _loginPath;
  _loginPath = process.env.PATH || '';
  if (process.platform !== 'win32') {
    try {
      const shell = process.env.SHELL || '/bin/zsh';
      const out = execFileSync(shell, ['-ilc', 'echo -n "$PATH"'], { encoding: 'utf8', timeout: 4000 });
      if (out && out.trim()) _loginPath = out.trim();
    } catch {
      /* fall back to the inherited PATH */
    }
  }
  return _loginPath;
}

function killChild(id) {
  const child = children.get(id);
  if (child) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already dead */
    }
    children.delete(id);
  }
}

/**
 * @param {string} cmd
 * @param {Record<string, unknown>} args
 * @returns command result (Promise for mcp_spawn), or `undefined` if not an mcp command.
 */
function mcpDispatch(cmd, args) {
  if (!MCP_CMDS.has(cmd)) return undefined;
  const a = args || {};
  switch (cmd) {
    case 'mcp_spawn':
      return mcpSpawn(a);
    case 'mcp_write':
      return mcpWrite(a);
    case 'mcp_kill':
      return mcpKill(a);
    default:
      return undefined;
  }
}

function mcpSpawn({ id, command, args = [], env = {}, heartbeat }) {
  const existing = children.get(id);
  if (existing && !existing.killed) {
    // Match Rust: refuse to replace a live process (the frontend does a
    // defensive mcp_kill before a legitimate re-spawn, so a live id here means
    // a real double-spawn) — tearing down the healthy one would be worse.
    return Promise.reject(new Error(`mcp_spawn: a process is already running for id "${id}"`));
  }

  const spawnEnv = { ...process.env, ...(env || {}) };
  let file = command;
  if (command === 'node') {
    // Electron's bundled Node — no system Node dependency.
    file = process.execPath;
    spawnEnv.ELECTRON_RUN_AS_NODE = '1';
  } else if (!(env && env.PATH)) {
    // Non-node commands (npx/python/uvx/a bare `node` on PATH): give them the
    // real login-shell PATH unless the caller pinned one.
    spawnEnv.PATH = loginShellPath();
  }

  let child;
  try {
    child = spawn(file, args || [], { env: spawnEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    return Promise.reject(new Error(`mcp_spawn failed for "${command}": ${errMsg(err)}`));
  }
  children.set(id, child);

  let spawned = false;
  let emittedClose = false;
  const emitCloseOnce = () => {
    if (emittedClose) return;
    emittedClose = true;
    children.delete(id);
    stopHeartbeatMonitor(id);
    emit(`mcp-close-${id}`, '');
  };

  // Line-framed stdout — one mcp-msg per line (trimmed), NDJSON.
  let outBuf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    outBuf += chunk;
    let nl;
    while ((nl = outBuf.indexOf('\n')) >= 0) {
      const line = outBuf.slice(0, nl).trim();
      outBuf = outBuf.slice(nl + 1);
      if (!line) continue;
      // Heartbeat ack interception — see consumeHeartbeatAck()'s JSDoc for
      // why this can never swallow a real RPC response.
      if (line.includes('__mcphb-') && consumeHeartbeatAck(id, line)) continue;
      emit(`mcp-msg-${id}`, line);
    }
  });

  // Line-framed stderr (persistent buffer, so a log line split across chunks
  // isn't fragmented — sidecarManager parses each line's `[level]` tag).
  let errBuf = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    errBuf += chunk;
    let nl;
    while ((nl = errBuf.indexOf('\n')) >= 0) {
      const line = errBuf.slice(0, nl).trimEnd();
      errBuf = errBuf.slice(nl + 1);
      if (line) emit(`mcp-err-${id}`, line);
    }
  });

  child.on('error', (err) => {
    if (spawned) {
      // Runtime error on a process that DID start — surface + close once.
      emit(`mcp-err-${id}`, `process error: ${errMsg(err)}`);
      emitCloseOnce();
    } else {
      // Spawn-phase failure — the rejected invoke below is the signal; no
      // mcp-err/close events (Rust emits none on spawn failure).
      children.delete(id);
    }
  });

  child.on('close', () => emitCloseOnce());

  return new Promise((resolve, reject) => {
    child.once('spawn', () => {
      spawned = true;
      if (heartbeat) startHeartbeatMonitor(id);
      resolve(null);
    });
    child.once('error', (err) => {
      if (!spawned) reject(new Error(`mcp_spawn failed for "${command}": ${errMsg(err)}`));
    });
  });
}

function mcpWrite({ id, message }) {
  const child = children.get(id);
  if (!child || !child.stdin || !child.stdin.writable) {
    throw new Error(`mcp_write: no live process for id "${id}"`);
  }
  child.stdin.write(String(message) + '\n');
  return null;
}

function mcpKill({ id }) {
  killChild(id);
  return null;
}

function errMsg(err) {
  return err instanceof Error ? err.message : String(err);
}

// No orphans: kill every spawned child on shell exit AND on termination
// signals. A signal doesn't run 'exit' handlers, and registering a handler
// suppresses Node's default terminate — so reproduce it (kill children, then
// exit). Main no longer runs the SidecarSupervisor, so this bridge owns the net.
function killAllChildren() {
  for (const child of children.values()) {
    if (child && !child.killed) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* nothing we can do */
      }
    }
  }
}
process.on('exit', killAllChildren);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(sig, () => {
    killAllChildren();
    process.exit(0);
  });
}

module.exports = { mcpDispatch };
