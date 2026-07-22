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
 */
'use strict';

const { spawn, execFileSync } = require('node:child_process');

/** id -> ChildProcess */
const children = new Map();

const MCP_CMDS = new Set(['mcp_spawn', 'mcp_write', 'mcp_kill']);

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

function mcpSpawn({ id, command, args = [], env = {} }) {
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
      if (line) emit(`mcp-msg-${id}`, line);
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
