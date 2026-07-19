#!/usr/bin/env node
/**
 * sidecar/src/main.ts — sidecar process entry point.
 *
 * P1-0 gave this process an idle ping/echo/shutdown skeleton
 * (see the original handwritten `sidecar/index.mjs`, now generated build
 * output — this file is its TypeScript replacement, ported byte-compatibly:
 * same methods, same notification rules, same stdout-protocol-only
 * discipline, same flush-before-exit, same error codes). P1-1 adds the
 * `llm.chat` / `llm.abort` protocol extension (see llmHost.ts) so the shell
 * can run the actual Claude/OpenAI-compatible streaming request in this
 * process instead of the webview.
 *
 * Protocol: newline-delimited JSON (NDJSON), JSON-RPC 2.0 over stdio.
 *   - stdin:  one JSON-RPC 2.0 message per line (LF-terminated).
 *   - stdout: one JSON-RPC 2.0 message per line — and ONLY that. Never write
 *             logs or anything else to stdout; the parent treats every stdout
 *             line as a protocol message. All diagnostics go to stderr.
 *
 * Methods:
 *   - `ping` → { pong: true, pid, uptimeMs }
 *   - `echo` → returns `params` verbatim as `result`
 *   - `llm.chat` → runs one streaming LLM call to completion; see llmHost.ts.
 *     The response settles only once the stream ends (or errors) — progress
 *     comes via `llm.event` / `llm.chatMeta` notifications in the meantime.
 *   - `fs.readTextFile` / `fs.readFile` / `fs.writeTextFile` / `fs.readDir` /
 *     `fs.exists` / `fs.stat` → P1-2a fs bridge for the agent's file tools;
 *     see fsHost.ts for implementation and the plugin-fs semantic mapping.
 * Notifications (no `id`):
 *   - `shutdown` → abort all active llm.chat calls, flush stdout, exit(0)
 *   - `llm.abort` → abort one in-flight `llm.chat` call by callId (idempotent,
 *     unknown callId is a silent no-op)
 * Notifications sidecar→shell:
 *   - `llm.event` → `{ callId, seq, event }` — one StreamEvent, coalesced
 *     (see eventCoalescer.ts)
 *   - `llm.chatMeta` → `{ callId, kind: 'maxTokensLimitDiscovered', limit }`
 *
 * Errors (JSON-RPC 2.0 standard codes):
 *   - Malformed JSON on a line → { code: -32700 } (Parse error), id: null
 *   - Non-object / array message → { code: -32600 } (Invalid Request)
 *   - Unknown method (on a request, i.e. has an id) → { code: -32601 }
 *   - Invalid `llm.chat`/`llm.abort`/`fs.*` params → { code: -32602 }
 *   - `llm.chat` adapter threw → { code: -32000 }, `data` carries the
 *     reconstructable LLMError shape (see llmHost.ts errorDataFor)
 *   - `fs.*` handler hit a real fs errno error (ENOENT, EACCES, ...) →
 *     { code: -32001 }, `data` carries `{ code, message, path }` (see
 *     fsHost.ts rethrowFsError)
 *
 * No npm dependencies at the SOURCE level beyond what bundles in (this file
 * imports the real `@anthropic-ai/sdk`-backed adapters) — the build output
 * (`sidecar/index.mjs`, produced by `scripts/build-sidecar.mjs`) is still a
 * single dependency-free file that runs standalone via `node index.mjs`,
 * with no build step needed at RUNTIME (see resolveResource('sidecar/index.mjs')
 * on the Rust side, which spawns it exactly as bundled).
 */

import { createInterface } from 'node:readline';
import { createLlmHost } from './llmHost';
import { fsReadTextFile, fsReadFile, fsWriteTextFile, fsReadDir, fsExists, fsStat } from './fsHost';
import {
  writeLine,
  makeError,
  makeResult,
  makeNotification,
  errorFromCaught,
  flushAndExit,
  type JsonRpcRequest,
} from './protocol';

const startedAt = Date.now();

/** All diagnostics go to stderr — stdout is reserved for protocol lines. */
function log(...args: unknown[]): void {
  console.error('[sidecar]', ...args);
}

const llmHost = createLlmHost({
  notify: (method, params) => writeLine(makeNotification(method, params)),
});

/**
 * In-flight async request counter — drives the bounded drain in the stdin
 * `close` handler below. Without it, `rl.on('close')` would `flushAndExit`
 * while fs/llm handlers are still mid-await, cutting off their work (a
 * `fs.writeTextFile` in flight at app quit could leave a truncated file)
 * and dropping their responses (which is also what used to make piped CLI
 * sanity runs against this file silently produce no output).
 */
let inFlightRequests = 0;

/** Run one async request handler without blocking the readline loop; the response is written when it settles. */
function runAsyncRequest(id: string | number | null, fn: () => Promise<unknown>): void {
  inFlightRequests += 1;
  void (async () => {
    try {
      const result = await fn();
      writeLine(makeResult(id, result));
    } catch (err) {
      writeLine(errorFromCaught(id, err));
    } finally {
      inFlightRequests -= 1;
    }
  })();
}

/** P1-2a fs bridge — method -> handler, all request/response (no notifications). See fsHost.ts. */
const fsHandlers: Record<string, (params: unknown) => Promise<unknown>> = {
  'fs.readTextFile': fsReadTextFile,
  'fs.readFile': fsReadFile,
  'fs.writeTextFile': fsWriteTextFile,
  'fs.readDir': fsReadDir,
  'fs.exists': fsExists,
  'fs.stat': fsStat,
};

function handleMessage(raw: string): void {
  let msg: unknown;
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

  const { id, method, params } = msg as JsonRpcRequest;
  // JSON-RPC 2.0: a member absent means notification; `id: null` is still a
  // (discouraged but valid) request and gets a response.
  const isNotification = id === undefined;

  if (typeof method !== 'string') {
    if (!isNotification) writeLine(makeError(id, -32600, 'Invalid Request'));
    return;
  }

  if (method === 'shutdown') {
    log('shutdown requested, exiting');
    llmHost.shutdownAll();
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

  if (method === 'llm.abort') {
    // Notification only — an abort is fire-and-forget from the shell's
    // perspective (it has its own 5s defensive timer independent of this).
    try {
      llmHost.handleAbort(params);
    } catch (err) {
      log('llm.abort handler threw (ignored — notifications get no response)', err);
    }
    return;
  }

  if (method === 'llm.chat') {
    if (isNotification) return; // must be a request — a notification has no id to respond to
    // Async from the readline loop's perspective: chat() can run for
    // minutes, and we must keep processing incoming lines (heartbeat
    // pings, llm.abort for THIS or other calls) while it's in flight.
    runAsyncRequest(id, () => llmHost.handleChat(params));
    return;
  }

  const fsHandler = fsHandlers[method];
  if (fsHandler) {
    if (isNotification) return; // must be a request — a notification has no id to respond to
    runAsyncRequest(id, () => fsHandler(params));
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
  // stdin closed (parent went away, or piped input ended). Abort streaming
  // LLM calls immediately (they can run for minutes — no reason to finish
  // them for a departed parent; the abort makes their handlers settle fast),
  // then give the remaining short-lived in-flight requests (fs ops) a
  // bounded window to finish so their work isn't cut off mid-write and
  // their responses still reach the pipe, then exit.
  llmHost.shutdownAll();
  const DRAIN_CAP_MS = 3_000;
  const deadline = Date.now() + DRAIN_CAP_MS;
  const tick = (): void => {
    if (inFlightRequests === 0 || Date.now() >= deadline) {
      flushAndExit(0);
      return;
    }
    setTimeout(tick, 10);
  };
  tick();
});

process.stdin.on('error', (err) => {
  log('stdin error:', err);
  flushAndExit(1);
});
