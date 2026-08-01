/**
 * Electron main-side pty (pseudo-terminal) host — port of Tauri's
 * `pty_spawn`/`pty_write`/`pty_resize`/`pty_kill` (src-tauri/src/pty.rs),
 * backing the workspace "terminal" tab (`@xterm/xterm` frontend, see
 * `src/components/panel/workspace/TerminalTab.tsx`) with a real
 * cross-platform pseudo-terminal via `node-pty` (native module, N-API —
 * see the file-level note in package.json / the P2-1 build report for the
 * native-rebuild story).
 *
 * ## Lifecycle (mirrors pty.rs)
 * - `pty_spawn` opens a pty via node-pty, and node-pty's own internal reader
 *   streams raw output bytes to the frontend via `pty://data/{id}` events
 *   (one `onData` callback per session, registered right after spawn — no
 *   separate thread needed, node-pty's `IPty` already streams asynchronously
 *   off a libuv-backed fd). On process exit it emits `pty://exit/{id}` with
 *   the child's exit code and removes the session.
 * - `pty_write` / `pty_resize` look up the session by id and act on it.
 * - `pty_kill` best-effort kills the child and removes the session; the
 *   `onExit` callback (already registered at spawn time) fires shortly after
 *   and emits the (single) `pty://exit/{id}` event — matching pty.rs, which
 *   also emits exactly one `pty://exit` per session, from the reader/reaper
 *   path rather than from `pty_kill` itself.
 *
 * ## Wire contract (verified against pty.rs + TerminalTab.tsx)
 * Frontend sends camelCase keys (Tauri auto-cased these to snake_case Rust
 * params; Electron's raw IPC does not) — `{ id, cols, rows, cwd }` for
 * pty_spawn, `{ id, data }` for pty_write, `{ id, cols, rows }` for
 * pty_resize, `{ id }` for pty_kill. Events: `pty://data/{id}` payload is a
 * `number[]` (TerminalTab.tsx:70 `listen<number[]>` + `new
 * Uint8Array(event.payload)`) — so onData chunks are emitted as
 * `Array.from(buffer)`, never a string. `pty://exit/{id}` payload is
 * `number | null` (TerminalTab.tsx's `listen<number | null>`, payload value
 * itself is never read — any event fires the "process exited" message).
 *
 * No-orphan: SIGINT/SIGTERM/SIGHUP + 'exit' guards kill every spawned pty
 * (same pattern as electron/mcpBridge.cjs).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const pty = require('node-pty');

/**
 * node-pty ships its POSIX spawn helper as a prebuilt binary at
 * `node_modules/node-pty/prebuilds/<platform>-<arch>/spawn-helper`. npm's
 * tarball pack/unpack does not reliably preserve the executable bit on this
 * file — node-pty's own `postinstall` (scripts/post-install.js) only cleans
 * up `build/Release`, never touching `prebuilds/` — so a plain, fresh
 * `npm install node-pty` can leave `spawn-helper` non-executable. When that
 * happens EVERY `pty.spawn()` call fails at runtime with `posix_spawnp
 * failed` (reproduced + confirmed the exact cause while building this file:
 * `require('node-pty')` loads fine under both plain Node and Electron —
 * proving the prebuilt `.node` binary itself is N-API/ABI-portable — but
 * spawning without this chmod fails on both). Self-heal here instead of
 * depending on a postinstall/README step having run in every environment
 * (including CI/packaging machines).
 */
function ensureSpawnHelperExecutable() {
  if (process.platform === 'win32') return; // Windows uses conpty, no spawn-helper
  try {
    const pkgPath = require.resolve('node-pty/package.json');
    const helper = path.join(
      path.dirname(pkgPath),
      'prebuilds',
      `${process.platform}-${process.arch}`,
      'spawn-helper'
    );
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  } catch {
    /* best-effort — if this fails, pty.spawn() below will surface the real error */
  }
}
ensureSpawnHelperExecutable();

/** id -> node-pty IPty instance */
const sessions = new Map();

const PTY_CMDS = new Set(['pty_spawn', 'pty_write', 'pty_resize', 'pty_kill']);
const PTY_MISS = Symbol('pty-dispatch-miss');

/** Cache the event-bridge emit after the first require (hot path: one call per data chunk). */
let _emitEvent = null;
function emit(event, payload) {
  if (!_emitEvent) _emitEvent = require('./tauriHost.cjs').emitEvent;
  _emitEvent(event, payload);
}

function errMsg(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resolve the shell to spawn — port of pty.rs's `candidate_shells`, minus the
 * try-spawn-and-fall-back loop: node-pty forks a child and execs it, so an
 * exec failure (bad shell path) surfaces as an early process exit rather than
 * a synchronous throw from `pty.spawn()` on POSIX, which would make a
 * try/catch fallback loop here silently no-op. Instead, since the unix
 * candidates are fixed absolute paths, we pick the first one that actually
 * exists on disk (equivalent outcome for the real-world case: a stale/unset
 * $SHELL falls through to /bin/zsh etc, same as Rust's spawn-failure
 * fallback would land on).
 */
function pickShell() {
  if (process.platform === 'win32') {
    // Rust doesn't pre-validate PATH lookups here either; trust the first
    // candidate (powershell.exe) — matches candidate_shells() priority.
    return 'powershell.exe';
  }
  const candidates = [];
  const shellEnv = process.env.SHELL;
  if (shellEnv && shellEnv.trim()) candidates.push(shellEnv.trim());
  for (const fallback of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (!candidates.includes(fallback)) candidates.push(fallback);
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* keep looking */
    }
  }
  return candidates[candidates.length - 1] || '/bin/sh';
}

function isDir(p) {
  try {
    return typeof p === 'string' && p.length > 0 && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * pty_spawn — camelCase wire args: `{ id, cols, rows, cwd }` (cwd optional).
 * Returns null on success (matches Rust's `Result<(), String>` -> `Ok(())`),
 * rejects on failure (Tauri command errors reject the frontend's invoke()).
 */
function ptySpawn({ id, cols, rows, cwd }) {
  if (sessions.has(id)) {
    return Promise.reject(new Error(`pty session '${id}' already running`));
  }

  const shell = pickShell();
  const validCwd = isDir(cwd) ? cwd : undefined;
  const env = { ...process.env };
  if (process.platform !== 'win32') env.TERM = 'xterm-256color';

  let ptyProcess;
  try {
    ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: Number(cols) > 0 ? Number(cols) : 80,
      rows: Number(rows) > 0 ? Number(rows) : 24,
      cwd: validCwd,
      env,
      // Raw bytes, not strings — pty://data/{id} must carry a byte array
      // (see file-level wire-contract note), same as pty.rs's Vec<u8> emit.
      encoding: null,
    });
  } catch (err) {
    return Promise.reject(new Error(`failed to spawn pty: ${errMsg(err)}`));
  }

  sessions.set(id, ptyProcess);

  ptyProcess.onData((chunk) => {
    // encoding: null makes node-pty forward raw Buffer chunks; Array.from
    // matches TerminalTab.tsx's `new Uint8Array(event.payload)` decode.
    const bytes = Buffer.isBuffer(chunk) ? Array.from(chunk) : Array.from(Buffer.from(String(chunk), 'utf8'));
    emit(`pty://data/${id}`, bytes);
  });

  ptyProcess.onExit(({ exitCode }) => {
    sessions.delete(id);
    emit(`pty://exit/${id}`, typeof exitCode === 'number' ? exitCode : null);
  });

  return null;
}

/** pty_write — camelCase wire args: `{ id, data }` (data is a decoded JS string, xterm's onData). */
function ptyWrite({ id, data }) {
  const session = sessions.get(id);
  if (!session) throw new Error(`pty session '${id}' not found`);
  session.write(String(data ?? ''));
  return null;
}

/** pty_resize — camelCase wire args: `{ id, cols, rows }`. */
function ptyResize({ id, cols, rows }) {
  const session = sessions.get(id);
  if (!session) throw new Error(`pty session '${id}' not found`);
  session.resize(Number(cols) > 0 ? Number(cols) : 80, Number(rows) > 0 ? Number(rows) : 24);
  return null;
}

/**
 * pty_kill — camelCase wire args: `{ id }`. Best-effort + idempotent (killing
 * an already-gone/never-existed id is not an error, matching pty.rs). Does
 * NOT itself emit pty://exit — the onExit callback registered at spawn time
 * does that once the child actually exits, exactly one event per session
 * (matches pty.rs, where pty_kill only removes+reaps and the background
 * reader thread's EOF path is the sole pty://exit emitter).
 */
function ptyKill({ id }) {
  const session = sessions.get(id);
  if (session) {
    try {
      session.kill();
    } catch {
      /* already dead */
    }
    sessions.delete(id);
  }
  return null;
}

/**
 * @param {import('electron').App} app unused — kept for signature parity
 *   with the other *Dispatch(app, cmd, args) families (e.g. commandDispatch).
 * @param {string} cmd
 * @param {Record<string, unknown>} args
 * @returns command result (a Promise for pty_spawn), or PTY_MISS if `cmd`
 *   isn't one of the pty family.
 */
function ptyDispatch(app, cmd, args) {
  void app;
  if (!PTY_CMDS.has(cmd)) return PTY_MISS;
  const a = args || {};
  switch (cmd) {
    case 'pty_spawn':
      return ptySpawn(a);
    case 'pty_write':
      return ptyWrite(a);
    case 'pty_resize':
      return ptyResize(a);
    case 'pty_kill':
      return ptyKill(a);
    default:
      return PTY_MISS;
  }
}

// No orphans: kill every live pty on shell exit AND on termination signals —
// same pattern as electron/mcpBridge.cjs (that bridge only owns MCP/sidecar
// child processes, not ptys, so this module needs its own guard).
function killAllPtys() {
  for (const session of sessions.values()) {
    try {
      session.kill();
    } catch {
      /* nothing we can do */
    }
  }
  sessions.clear();
}
process.on('exit', killAllPtys);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(sig, () => {
    killAllPtys();
    process.exit(0);
  });
}

module.exports = { ptyDispatch, PTY_MISS, killAllPtys };
