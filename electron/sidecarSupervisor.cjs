/**
 * Sidecar Supervisor (Electron shell) — Phase 2 slice 1.
 *
 * The Electron-side counterpart of the Tauri shell's
 * `src/core/sidecar/sidecarManager.ts`. It spawns the SAME dependency-free
 * sidecar bundle (`sidecar/index.mjs`, built by `npm run build:sidecar`),
 * talks its NDJSON JSON-RPC 2.0 stdio protocol, and keeps it alive with the
 * same restart policy — but the transport is Node `child_process` stdio
 * pipes instead of Tauri's `mcp_spawn`/`mcp_write`/`mcp_kill` bridge + Tauri
 * events.
 *
 * The supervision SEMANTICS are ported verbatim from sidecarManager.ts so the
 * two shells behave identically (this is the "same runtime, two shells" goal):
 *   - Heartbeat: ping every 10s, 5s timeout, 3 consecutive failures ⇒ force
 *     restart (a hung-but-alive sidecar is restarted, not just a dead one).
 *   - Crash-loop guard: any failure (spawn error, unexpected exit, heartbeat
 *     hang) counts as one entry in a rolling 60s window; >3 in the window ⇒
 *     give up (status 'failed'), no more respawns until start() is called from
 *     a clean/failed state.
 *   - Restart backoff: 500ms before a respawn, to avoid a tight loop.
 *   - reject-all-pending on close, deliberate-stop vs unexpected-close
 *     discrimination, self-initiated-kill echo suppression.
 *
 * Electron-specific concern this file adds over the Tauri version: **no
 * orphan on shell exit**. A Node child is NOT killed when its parent process
 * exits, so the shell must explicitly kill the sidecar on quit. `start()`
 * installs process-level guards (see installExitGuards) that SIGKILL the child
 * on the shell's own exit/signals; the Electron main also calls stop() on
 * app 'will-quit' (see electron/main.cjs).
 *
 * Fail-soft like the Tauri version: nothing here throws out of start()/stop();
 * every failure path logs and is handled by the restart policy.
 */
'use strict';

const { spawn } = require('node:child_process');

// ── Policy constants (identical to sidecarManager.ts) ──
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 5_000;
const HEARTBEAT_FAILURE_THRESHOLD = 3;
const REQUEST_DEFAULT_TIMEOUT_MS = 5_000;
const CRASH_LOOP_WINDOW_MS = 60_000;
const CRASH_LOOP_MAX_RESTARTS = 3;
const RESTART_BACKOFF_MS = 500;

/** JSON-RPC error carrying the raw code/data through (mirrors SidecarRpcError). */
class SidecarRpcError extends Error {
  constructor(code, message, data) {
    super(`Sidecar error ${code}: ${message}`);
    this.name = 'SidecarRpcError';
    this.code = code;
    this.data = data;
  }
}

/** Error a reverse-request handler can throw to control the JSON-RPC error sent back. */
class SidecarRequestError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'SidecarRequestError';
    this.code = code;
    this.data = data;
  }
}

class SidecarSupervisor {
  /**
   * @param {object} opts
   * @param {string} opts.sidecarPath   Absolute path to sidecar/index.mjs.
   * @param {string} opts.electronPath  process.execPath — Electron's bundled
   *   Node, spawned with ELECTRON_RUN_AS_NODE=1 (the packaged-app-realistic
   *   setup: no system Node dependency).
   * @param {Record<string,string>} [opts.env]  Extra env for the sidecar
   *   (ABU_APP_DATA_DIR / ABU_RESOURCE_DIR — see sidecar/src/bootstrap.ts).
   * @param {(level:string,msg:string,extra?:object)=>void} [opts.log]
   */
  constructor(opts) {
    this.sidecarPath = opts.sidecarPath;
    this.electronPath = opts.electronPath;
    this.extraEnv = opts.env || {};
    this.log = opts.log || (() => {});

    this.status = 'stopped';
    this.child = null;
    this.stdoutBuf = '';
    this.nextRequestId = 1;
    this.pending = new Map(); // id(number) -> { resolve, reject, timer }
    this.notificationHandlers = new Map(); // method -> Set<fn>
    this.requestHandlers = new Map(); // method -> fn (reverse channel)

    this.heartbeatTimer = null;
    this.heartbeatFailures = 0;
    this.restartTimestamps = [];
    this.crashLoopWarned = false;
    this.deliberatelyStopped = true;
    this.exitGuardsInstalled = false;
    this.restartTimer = null;
  }

  getStatus() {
    return this.status;
  }

  /** pid of the current sidecar child, or null. Used by the acceptance harness. */
  getSidecarPid() {
    // Liveness is tracked by nulling this.child on close/stop — child.killed is
    // NOT set by an external SIGKILL, so a live child ⇒ a live pid.
    return this.child ? this.child.pid : null;
  }

  /**
   * Start (or no-op if already active). Never throws; failures are handled by
   * the restart policy — check getStatus() for the eventual outcome.
   */
  start() {
    if (this.status === 'starting' || this.status === 'running' || this.status === 'restarting') {
      return;
    }
    this.deliberatelyStopped = false;
    this.crashLoopWarned = false;
    this.restartTimestamps = [];
    this._installExitGuards();
    this._attemptSpawn('initial');
  }

  /** Deliberate stop: clear timers, reject pending, kill child, status 'stopped'. */
  async stop() {
    this.deliberatelyStopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this._stopHeartbeat();
    this._rejectAllPending(new Error('Sidecar stopped'));
    this.restartTimestamps = [];
    this.crashLoopWarned = false;
    this.status = 'stopped';
    await this._killChild();
  }

  /** Send a JSON-RPC request; resolve/reject on correlated response or timeout. */
  request(method, params, timeoutMs = REQUEST_DEFAULT_TIMEOUT_MS) {
    const id = this.nextRequestId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`Sidecar request "${method}" timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : null;
      this.pending.set(id, { resolve, reject, timer });
      if (!this._write(payload)) {
        const entry = this.pending.get(id);
        if (entry) {
          if (entry.timer) clearTimeout(entry.timer);
          this.pending.delete(id);
        }
        reject(new Error('Sidecar stdin not writable'));
      }
    });
  }

  /** Fire-and-forget notification (no id, no response). */
  notify(method, params) {
    this._write(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  /** Subscribe to a sidecar→shell notification. Returns an unsubscribe fn. */
  onNotification(method, handler) {
    let set = this.notificationHandlers.get(method);
    if (!set) {
      set = new Set();
      this.notificationHandlers.set(method, set);
    }
    set.add(handler);
    return () => {
      const cur = this.notificationHandlers.get(method);
      if (!cur) return;
      cur.delete(handler);
      if (cur.size === 0) this.notificationHandlers.delete(method);
    };
  }

  /** Register the single handler for a sidecar→shell REQUEST method (reverse channel). */
  onRequest(method, handler) {
    this.requestHandlers.set(method, handler);
    return () => {
      if (this.requestHandlers.get(method) === handler) this.requestHandlers.delete(method);
    };
  }

  // ── Spawn / restart machinery ──

  _attemptSpawn(kind) {
    // A deliberate stop() during the restart backoff must not spawn again.
    if (this.deliberatelyStopped) {
      this.status = 'stopped';
      return;
    }
    this.status = kind === 'initial' ? 'starting' : 'restarting';

    let child;
    try {
      child = spawn(this.electronPath, [this.sidecarPath], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...this.extraEnv },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this._handleSpawnFailure(err, 'spawn-threw');
      return;
    }

    this.child = child;
    this.stdoutBuf = '';

    // Decode stdout/stderr as UTF-8 at the stream level: the stream's internal
    // StringDecoder holds an incomplete multibyte sequence across chunk
    // boundaries, so a CJK char split between two 'data' chunks is NOT
    // corrupted into U+FFFD (the Tauri reference never hit this — it received
    // already-decoded string payloads).
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.on('error', (err) => {
      // e.g. ENOENT / EACCES on the executable itself.
      this._handleSpawnFailure(err, 'spawn-error-event');
    });

    // Ignore data from any child that is no longer the current one, so a late
    // chunk from a previous generation can't land in the new generation's
    // shared line buffer and mis-frame it.
    child.stdout.on('data', (chunk) => {
      if (child === this.child) this._onStdout(chunk);
    });
    child.stderr.on('data', (chunk) => {
      // Surface sidecar stderr at the matching level, like sidecarManager's
      // B1 fix (untagged lines default to warn — better loud than lost).
      const line = String(chunk).trim();
      if (!line) return;
      const level = /\]\s*\[(debug|info|warn|error)\]/.exec(line)?.[1] || 'warn';
      this.log(level, 'sidecar stderr', { line });
    });

    // 'close' (not 'exit') so all buffered stdout drains before we reject
    // pending requests — matches the reference's handleClose drain-before-reject
    // ordering. Passing `child` lets _handleExit ignore a stale generation.
    child.on('close', (code, signal) => this._handleExit(child, code, signal));

    // spawn() is synchronous in giving us a child+pid; consider it running.
    // Any immediate failure surfaces via the 'error'/'close' events above.
    this.status = 'running';
    this._startHeartbeat();
    void this._selfTestEcho();
  }

  _handleSpawnFailure(err, reason) {
    this.log('warn', 'Sidecar spawn failed', { reason, error: errMsg(err) });
    this._scheduleRestartOrGiveUp(reason);
  }

  _scheduleRestartOrGiveUp(reason) {
    if (this.deliberatelyStopped) {
      this.status = 'stopped';
      return;
    }
    const now = Date.now();
    this.restartTimestamps.push(now);
    this.restartTimestamps = this.restartTimestamps.filter((t) => now - t <= CRASH_LOOP_WINDOW_MS);

    if (this.restartTimestamps.length > CRASH_LOOP_MAX_RESTARTS) {
      this.status = 'failed';
      if (!this.crashLoopWarned) {
        this.crashLoopWarned = true;
        this.log('warn', 'Sidecar crash-looped — giving up', {
          reason,
          restartsInWindow: this.restartTimestamps.length,
          windowMs: CRASH_LOOP_WINDOW_MS,
        });
      }
      return;
    }

    this.status = 'restarting';
    this.log('warn', 'Sidecar restarting', { reason, attempt: this.restartTimestamps.length });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this._attemptSpawn('restart');
    }, RESTART_BACKOFF_MS);
  }

  async _selfTestEcho() {
    const start = Date.now();
    try {
      await this.request('echo', { selfTest: true }, REQUEST_DEFAULT_TIMEOUT_MS);
      this.log('debug', 'Sidecar self-test echo round-trip', { latencyMs: Date.now() - start });
    } catch (err) {
      this.log('warn', 'Sidecar self-test echo failed', { error: errMsg(err) });
    }
  }

  // ── Heartbeat ──

  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatFailures = 0;
    this.heartbeatTimer = setInterval(() => void this._runHeartbeat(), HEARTBEAT_INTERVAL_MS);
    // Don't let the heartbeat timer keep the event loop / process alive on its own.
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async _runHeartbeat() {
    if (this.status !== 'running') return;
    try {
      await this.request('ping', undefined, HEARTBEAT_TIMEOUT_MS);
      this.heartbeatFailures = 0;
    } catch (err) {
      this.heartbeatFailures += 1;
      if (this.heartbeatFailures < HEARTBEAT_FAILURE_THRESHOLD) {
        this.log('warn', 'Sidecar heartbeat failed', { failures: this.heartbeatFailures, error: errMsg(err) });
        return;
      }
      this.log('warn', 'Sidecar heartbeat threshold exceeded — forcing restart', {
        failures: this.heartbeatFailures,
      });
      this.heartbeatFailures = 0;
      this._stopHeartbeat();
      // Flip to 'restarting' BEFORE killing, so the exit this kill triggers is
      // recognized as self-initiated by _handleExit().
      this.status = 'restarting';
      await this._killChild();
      this._scheduleRestartOrGiveUp('heartbeat-hung');
    }
  }

  // ── stdout framing + dispatch ──

  _onStdout(chunk) {
    this.stdoutBuf += String(chunk);
    let nl;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl);
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (!line.trim()) continue;
      this._handleMessage(line);
    }
  }

  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.log('warn', 'Sidecar sent malformed message on stdout', { raw });
      return;
    }

    // Incoming REQUEST from the sidecar (method AND id, INCLUDING id:null) —
    // reverse channel. Matches the reference: any method-bearing message with
    // an id gets a response; excluding id:null would drop it through to the
    // response branch and hang the sidecar waiting for a reply.
    if (typeof msg.method === 'string' && msg.id !== undefined) {
      void this._handleIncomingRequest(msg.method, msg.id, msg.params);
      return;
    }
    // Notification (method, no id).
    if (typeof msg.method === 'string' && msg.id === undefined) {
      const set = this.notificationHandlers.get(msg.method);
      if (set) {
        for (const h of set) {
          try {
            h(msg.params);
          } catch (err) {
            this.log('warn', 'Sidecar notification handler threw', { method: msg.method, error: errMsg(err) });
          }
        }
      }
      return;
    }
    // Response to a request we sent (numeric id).
    if (typeof msg.id !== 'number') return;
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.pending.delete(msg.id);
    if (msg.error) entry.reject(new SidecarRpcError(msg.error.code, msg.error.message, msg.error.data));
    else entry.resolve(msg.result);
  }

  async _handleIncomingRequest(method, id, params) {
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      this._write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }));
      return;
    }
    try {
      const result = await handler(params);
      this._write(JSON.stringify({ jsonrpc: '2.0', id, result }));
    } catch (err) {
      const message = errMsg(err);
      const code = err instanceof SidecarRequestError ? err.code : -32000;
      const data = err instanceof SidecarRequestError ? err.data : undefined;
      this._write(JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: data !== undefined ? { code, message, data } : { code, message },
      }));
    }
  }

  // ── exit / cleanup ──

  _handleExit(child, code, signal) {
    // Ignore a 'close' from a previous generation: a slow-dying old child must
    // not restart a healthy new one (the reference couldn't guard this — it had
    // one shared Rust event name; the port has a distinct child per spawn).
    // A deliberate kill (_killChild) has already nulled this.child, so its
    // close also lands here and early-returns.
    if (child !== this.child) return;
    this.child = null; // liveness: getSidecarPid() now reports null

    this._stopHeartbeat();
    this._rejectAllPending(new Error(`Sidecar process closed (code=${code} signal=${signal})`));

    if (this.deliberatelyStopped) {
      this.status = 'stopped';
      return;
    }
    if (this.status === 'starting' || this.status === 'restarting' || this.status === 'failed') {
      // We've already given up, or a kill is mid-flight — don't double-count
      // as a new failure.
      return;
    }
    this._scheduleRestartOrGiveUp('close');
  }

  _rejectAllPending(err) {
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  /** Write a line to the sidecar's stdin. Returns false if not writable. */
  _write(payload) {
    const child = this.child;
    if (!child || child.killed || !child.stdin || !child.stdin.writable) return false;
    try {
      child.stdin.write(payload + '\n');
      return true;
    } catch (err) {
      this.log('warn', 'Sidecar stdin write failed', { error: errMsg(err) });
      return false;
    }
  }

  /** SIGKILL the current child and wait (briefly) for its 'exit'. Best-effort. */
  _killChild() {
    const child = this.child;
    if (!child || child.killed) {
      this.child = null;
      return Promise.resolve();
    }
    this.child = null;
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      child.once('exit', finish);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already dead */
      }
      setTimeout(finish, 2000).unref?.();
    });
  }

  /**
   * Install process-level guards so a sidecar child is never orphaned when the
   * Electron shell process itself exits (Node does not auto-kill children).
   * `exit` cannot run async work, so it does a synchronous best-effort kill.
   */
  _installExitGuards() {
    if (this.exitGuardsInstalled) return;
    this.exitGuardsInstalled = true;
    // Synchronous no-orphan net on ANY normal exit / process.exit().
    process.on('exit', () => {
      const child = this.child;
      if (child && !child.killed) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* nothing we can do at exit */
        }
      }
    });
    // A termination signal does NOT run 'exit' handlers, and merely registering
    // a handler suppresses Node's default terminate — so reproduce termination
    // ourselves: stop resurrection, kill the child, then actually exit (the
    // 'exit' net above is the backstop). Without this the shell became
    // un-terminable and the restart policy resurrected the sidecar.
    const onSignal = () => {
      this.deliberatelyStopped = true;
      if (this.restartTimer) {
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
      }
      const child = this.child;
      if (child && !child.killed) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      }
      process.exit(0);
    };
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, onSignal);
  }
}

function errMsg(err) {
  return err instanceof Error ? err.message : String(err);
}

module.exports = { SidecarSupervisor, SidecarRpcError, SidecarRequestError };
