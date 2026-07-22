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
 * This is what lets the frontend actually talk to a sidecar/MCP server under
 * Electron (previously mcp_* were benign stubs → the frontend's sidecar was
 * dead → LLM calls failed). It also resolves the "frontend spawns a second
 * sidecar" conflict: main no longer runs its own supervisor (see main.cjs);
 * the frontend drives the one sidecar via this bridge, matching how it worked
 * on Tauri.
 *
 * Protocol notes (matching Tauri):
 *  - stdout is line-framed: one `mcp-msg-{id}` event per '\n'-terminated line,
 *    trimmed (NDJSON JSON-RPC).
 *  - mcp_write appends '\n' to the message (the frontend sends a bare JSON line).
 *  - `command: 'node'` runs Electron's bundled Node via ELECTRON_RUN_AS_NODE
 *    (the Rust bridge used a bundled-node PATH fallback; same intent, no system
 *    Node dependency). Other commands (npx/python/…) spawn as-is.
 */
'use strict';

const { spawn } = require('node:child_process');

/** id -> ChildProcess */
const children = new Map();

const MCP_CMDS = new Set(['mcp_spawn', 'mcp_write', 'mcp_kill']);

/** Lazy require of the event bridge (tauriHost requires nothing from here, but keep it lazy for symmetry/safety). */
function emit(event, payload) {
  const { emitEvent } = require('./tauriHost.cjs');
  emitEvent(event, payload);
}

/**
 * @param {string} cmd
 * @param {Record<string, unknown>} args
 * @returns the command result, or `undefined` if `cmd` isn't an mcp command.
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

function mcpSpawn({ id, command, args = [], env = {} }) {
  // The frontend does a defensive pre-spawn kill of any stale entry with the
  // same id; mirror the Rust bridge and clear ours too.
  killChild(id);

  let file = command;
  const spawnEnv = { ...process.env, ...(env || {}) };
  if (command === 'node') {
    // Electron's bundled Node — no system Node dependency (Rust used a bundled
    // node PATH fallback; ELECTRON_RUN_AS_NODE is the Electron equivalent).
    file = process.execPath;
    spawnEnv.ELECTRON_RUN_AS_NODE = '1';
  }

  let child;
  try {
    child = spawn(file, args || [], { env: spawnEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    throw new Error(`mcp_spawn failed for "${command}": ${err instanceof Error ? err.message : String(err)}`);
  }
  children.set(id, child);

  // Line-framed stdout → one mcp-msg event per line (trimmed), NDJSON.
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) emit(`mcp-msg-${id}`, line);
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    for (const raw of String(chunk).split('\n')) {
      const line = raw.trimEnd();
      if (line) emit(`mcp-err-${id}`, line);
    }
  });

  child.on('error', (err) => {
    emit(`mcp-err-${id}`, `process error: ${err instanceof Error ? err.message : String(err)}`);
    children.delete(id);
    emit(`mcp-close-${id}`, '');
  });

  child.on('close', () => {
    children.delete(id);
    emit(`mcp-close-${id}`, '');
  });

  return null;
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

// No orphans: kill every spawned child on shell exit (Node children aren't
// auto-reaped). Synchronous best-effort, like sidecarSupervisor's exit guard.
process.on('exit', () => {
  for (const child of children.values()) {
    if (child && !child.killed) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* nothing we can do at exit */
      }
    }
  }
});

module.exports = { mcpDispatch };
