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
 *  - node/npm/npx/python/python3 resolve to Abu's pinned standalone runtimes.
 *  - Other commands (uvx/…) get Abu's runtime dirs plus a login-shell PATH.
 *  - mcp_spawn REJECTS on spawn failure (ENOENT) and REJECTS if a live process
 *    already holds the id (never tears down the existing one) — matching Rust.
 *  - Exactly one `mcp-close-{id}` per process; none on a spawn-phase failure
 *    (the rejected invoke is that signal).
 *
 * Every process runs through sandbox-launcher's stdio supervisor mode. Unix
 * process groups / Windows Job Objects keep descendants owned even after npx
 * or another bootstrap process exits; the native launcher monitors Electron's
 * PID so SIGKILL/crashes are covered without JavaScript cleanup.
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
const { resolveBundledProgram, withBundledRuntimeEnv } = require('./runtimeResolver.cjs');
const {
  sandboxLauncherPathFor,
  unixDescendantPids,
} = require('./commandHost.cjs');

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
  if (
    !state ||
    !child ||
    !child.stdin ||
    !child.stdin.writable ||
    child.stdin.destroyed ||
    child.stdin.writableEnded
  ) return;
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
  if (!state) return false;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed.id !== 'string' || !parsed.id.startsWith('__mcphb-')) return false;

  // Any heartbeat-shaped id must never reach the renderer, even if it's a
  // stale/late ack (its ping already timed out and pendingId moved on, or was
  // cleared to null) — swallow it, but only touch pending/failure bookkeeping
  // when it's the CURRENT outstanding ping.
  if (state.pendingId !== null && parsed.id === state.pendingId) {
    if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
    state.timeoutTimer = null;
    state.pendingId = null;
    state.failures = 0;
  }
  return true;
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

function killProcessTree(child) {
  if (!child || child.__abuTreeKillStarted) return;
  child.__abuTreeKillStarted = true;

  if (process.platform !== 'win32') {
    for (const pid of unixDescendantPids(child.pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already dead */
      }
    }
    if (Number.isInteger(child.__abuTargetPid) && child.__abuTargetPid > 0) {
      try {
        process.kill(-child.__abuTargetPid, 'SIGKILL');
      } catch {
        /* already dead */
      }
    }
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      /* fall through to direct launcher kill */
    }
  }

  try {
    child.kill('SIGKILL');
  } catch {
    /* already dead */
  }
}

function killChild(id) {
  const child = children.get(id);
  if (child) {
    killProcessTree(child);
    children.delete(id);
  }
  // Stop the monitor even if `child` was already gone (defensive) — otherwise
  // an already-scheduled heartbeat timeout timer can still fire after this
  // kill and emit a spurious mcp-hung-{id} for a process we just tore down.
  stopHeartbeatMonitor(id);
}

/**
 * @param {string} cmd
 * @param {Record<string, unknown>} args
 * @returns command result (Promise for mcp_spawn), or `undefined` if not an mcp command.
 */
function mcpDispatch(appOrCmd, cmdOrArgs, maybeArgs) {
  const app = typeof appOrCmd === 'string' ? undefined : appOrCmd;
  const cmd = typeof appOrCmd === 'string' ? appOrCmd : cmdOrArgs;
  const args = typeof appOrCmd === 'string' ? cmdOrArgs : maybeArgs;
  if (!MCP_CMDS.has(cmd)) return undefined;
  const a = args || {};
  switch (cmd) {
    case 'mcp_spawn':
      return mcpSpawn(app, a);
    case 'mcp_write':
      return mcpWrite(a);
    case 'mcp_kill':
      return mcpKill(a);
    default:
      return undefined;
  }
}

function mcpSpawn(app, { id, command, args = [], env = {}, heartbeat }) {
  const existing = children.get(id);
  if (existing && !existing.killed) {
    // Match Rust: refuse to replace a live process (the frontend does a
    // defensive mcp_kill before a legitimate re-spawn, so a live id here means
    // a real double-spawn) — tearing down the healthy one would be worse.
    return Promise.reject(new Error(`mcp_spawn: a process is already running for id "${id}"`));
  }

  const callerEnv = { ...process.env, ...(env || {}) };
  const callerPinnedPath = env && Object.keys(env).some((key) => key.toLowerCase() === 'path');
  if (!callerPinnedPath) {
    callerEnv.PATH = loginShellPath();
  }

  let resolved;
  let spawnEnv;
  try {
    resolved = resolveBundledProgram(app, String(command || ''), args || []);
    spawnEnv = withBundledRuntimeEnv(app, callerEnv);
    if (heartbeat) spawnEnv.ABU_ELECTRON_COMMAND_HOST = '1';
  } catch (err) {
    return Promise.reject(new Error(`mcp_spawn failed for "${command}": ${errMsg(err)}`));
  }

  const launcherPath = sandboxLauncherPathFor(app);
  let child;
  try {
    child = spawn(launcherPath, [], {
      env: spawnEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
  } catch (err) {
    return Promise.reject(new Error(`mcp_spawn failed for "${command}": ${errMsg(err)}`));
  }
  children.set(id, child);

  let targetReady = false;
  let emittedClose = false;
  let settleSpawn;
  let rejectSpawn;
  let launchError = '';
  const spawnPromise = new Promise((resolve, reject) => {
    settleSpawn = resolve;
    rejectSpawn = reject;
  });
  const emitCloseOnce = () => {
    if (emittedClose) return;
    emittedClose = true;
    // Generation-safe teardown: `child` is THIS closure's own process,
    // captured at mcpSpawn-time. If a NEW generation has since been spawned
    // for the same `id` (old child killed via mcp_kill, which deletes it from
    // `children` and lets a fresh mcp_spawn register under the same id), this
    // old generation's late 'close' must be a no-op w.r.t. shared state — it
    // must NOT delete the live new child, stop ITS heartbeat monitor, or
    // emit a spurious mcp-close-{id} for it. Only tear down/emit when this
    // closure's child is still the one actually registered.
    if (children.get(id) === child) {
      children.delete(id);
      stopHeartbeatMonitor(id);
      if (targetReady) emit(`mcp-close-${id}`, '');
    }
  };

  // A pipe can close between a `.writable` check and `write()`. Node reports
  // that race asynchronously on the stdin stream (typically EPIPE), so a
  // try/catch around write cannot prevent an uncaught main-process exception.
  // Keep a lifetime listener on every child stdin. A broken input pipe makes
  // the process unusable for JSON-RPC; retire this exact generation and let the
  // renderer's existing mcp-close recovery path restart it.
  child.stdin.on('error', (err) => {
    if (children.get(id) !== child) return;
    if (targetReady) {
      emit(`mcp-err-${id}`, `stdin error: ${errMsg(err)}`);
    } else {
      rejectSpawn(new Error(`mcp_spawn failed for "${command}": stdin error: ${errMsg(err)}`));
    }
    killProcessTree(child);
    emitCloseOnce();
  });

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
      const readyMatch = line.match(/^\[sandbox-launcher-ready\]\s+(\d+)$/);
      if (readyMatch && !targetReady) {
        if (children.get(id) !== child) {
          killProcessTree(child);
          continue;
        }
        targetReady = true;
        child.__abuTargetPid = Number(readyMatch[1]);
        if (heartbeat) startHeartbeatMonitor(id);
        settleSpawn(null);
        continue;
      }
      if (line) {
        launchError = launchError ? `${launchError}\n${line}` : line;
        if (targetReady) emit(`mcp-err-${id}`, line);
      }
    }
  });

  child.on('error', (err) => {
    if (targetReady) {
      // Runtime error on a process that DID start — surface + close once.
      emit(`mcp-err-${id}`, `process error: ${errMsg(err)}`);
      emitCloseOnce();
    } else {
      // Spawn-phase failure — the rejected invoke is the signal; no
      // mcp-err/close events (Rust emits none on spawn failure).
      if (children.get(id) === child) children.delete(id);
      rejectSpawn(new Error(`mcp_spawn failed for "${command}": ${errMsg(err)}`));
    }
  });

  child.on('close', (code) => {
    if (!targetReady) {
      if (children.get(id) === child) children.delete(id);
      rejectSpawn(new Error(
        `mcp_spawn failed for "${command}": launcher exited with ${String(code)}${launchError ? `: ${launchError}` : ''}`
      ));
      return;
    }
    emitCloseOnce();
  });

  child.once('spawn', () => {
    try {
      child.stdin.write(`${JSON.stringify({
        file: resolved.file,
        args: resolved.args,
        sandboxEnabled: false,
        monitorParent: false,
        stdioPassthrough: true,
        parentPid: process.pid,
      })}\n`);
    } catch (err) {
      rejectSpawn(new Error(`mcp_spawn failed for "${command}": ${errMsg(err)}`));
      killProcessTree(child);
    }
  });

  return spawnPromise;
}

function mcpWrite({ id, message }) {
  const child = children.get(id);
  if (
    !child ||
    !child.stdin ||
    !child.stdin.writable ||
    child.stdin.destroyed ||
    child.stdin.writableEnded
  ) {
    return Promise.reject(new Error(`mcp_write: no live process for id "${id}"`));
  }
  return new Promise((resolve, reject) => {
    try {
      child.stdin.write(String(message) + '\n', (err) => {
        if (err) {
          reject(new Error(`mcp_write failed for id "${id}": ${errMsg(err)}`));
        } else {
          resolve(null);
        }
      });
    } catch (err) {
      reject(new Error(`mcp_write failed for id "${id}": ${errMsg(err)}`));
    }
  });
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
  for (const id of Array.from(children.keys())) killChild(id);
}
process.on('exit', killAllChildren);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(sig, () => {
    killAllChildren();
    process.exit(0);
  });
}

module.exports = { mcpDispatch };
