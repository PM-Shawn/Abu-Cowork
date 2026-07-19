#!/usr/bin/env node
// sidecar/index.mjs
//
// P1-0: idle sidecar process skeleton (see
// docs/2026-07-19-phase1-process-split-design.md §1, §2, §5 "P1-0").
// This is step 1 of extracting the agent loop into a headless Node sidecar.
// In P1-0 the sidecar does nothing product-facing yet — it's just a process
// the shell can spawn, talk to over stdio, and supervise (heartbeat +
// auto-restart). Zero behavior change to the app.
//
// Protocol: newline-delimited JSON (NDJSON), JSON-RPC 2.0 over stdio.
//   - stdin:  one JSON-RPC 2.0 message per line (LF-terminated).
//   - stdout: one JSON-RPC 2.0 response per line — and ONLY that. Never write
//             logs or anything else to stdout; the parent treats every stdout
//             line as a protocol message. All diagnostics go to stderr.
//
// Methods:
//   - `ping` → { pong: true, pid, uptimeMs }
//   - `echo` → returns `params` verbatim as `result`
// Notifications (no `id`):
//   - `shutdown` → flush stdout, then exit(0)
//
// Errors (JSON-RPC 2.0 standard codes):
//   - Malformed JSON on a line → { code: -32700 } (Parse error), id: null
//   - Non-object / array message → { code: -32600 } (Invalid Request)
//   - Unknown method (on a request, i.e. has an id) → { code: -32601 }
//
// No npm dependencies — this file must run standalone via `node index.mjs`,
// with no build step (see resolveResource('sidecar/index.mjs') on the Rust
// side, which spawns it exactly as bundled).

import { createInterface } from 'node:readline';

const startedAt = Date.now();

/** All diagnostics go to stderr — stdout is reserved for protocol lines. */
function log(...args) {
  console.error('[sidecar]', ...args);
}

/**
 * Write one JSON-RPC message as a single stdout line.
 * `flush(cb)` is used by the exit paths below to make sure this write has
 * actually reached the pipe before the process exits — on POSIX, Node's
 * stdout is asynchronous when the destination is a pipe (which it is here,
 * since the parent spawns us with piped stdio), so a bare `process.exit()`
 * right after a write can truncate it.
 */
function writeLine(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function makeError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function makeResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

/** Exit only after any queued stdout writes have been flushed to the pipe. */
function flushAndExit(code) {
  process.stdout.write('', () => process.exit(code));
}

function handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    // Per JSON-RPC 2.0 §4.1 / §5.1: on parse failure we don't know the
    // request id, so respond with id: null.
    writeLine(makeError(null, -32700, 'Parse error'));
    return;
  }

  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
    writeLine(makeError(null, -32600, 'Invalid Request'));
    return;
  }

  const { id, method, params } = msg;
  // JSON-RPC 2.0: a member absent means notification; `id: null` is still a
  // (discouraged but valid) request and gets a response.
  const isNotification = id === undefined;

  if (typeof method !== 'string') {
    if (!isNotification) writeLine(makeError(id, -32600, 'Invalid Request'));
    return;
  }

  if (method === 'shutdown') {
    log('shutdown requested, exiting');
    flushAndExit(0);
    return;
  }

  if (method === 'ping') {
    if (!isNotification) {
      writeLine(makeResult(id, { pong: true, pid: process.pid, uptimeMs: Date.now() - startedAt }));
    }
    return;
  }

  if (method === 'echo') {
    // "returned verbatim" — but keep the `result` member present even when
    // params was omitted, so the response always satisfies JSON-RPC shape.
    if (!isNotification) {
      writeLine(makeResult(id, params === undefined ? null : params));
    }
    return;
  }

  if (!isNotification) {
    writeLine(makeError(id, -32601, `Method not found: ${method}`));
  }
  // Unknown-method notifications are silently dropped — no id to reply to,
  // and JSON-RPC notifications never get responses.
}

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    handleMessage(trimmed);
  } catch (err) {
    // Belt-and-suspenders: never let a bad line crash the process.
    log('unexpected error handling message:', err);
    try {
      writeLine(makeError(null, -32603, 'Internal error'));
    } catch {
      // stdout itself is broken — nothing more we can do.
    }
  }
});

rl.on('close', () => {
  // stdin closed (parent went away, or piped input ended) — exit cleanly.
  flushAndExit(0);
});

process.stdin.on('error', (err) => {
  log('stdin error:', err);
  flushAndExit(1);
});
