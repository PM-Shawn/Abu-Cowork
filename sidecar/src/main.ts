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
 *   - Invalid `llm.chat`/`llm.abort` params → { code: -32602 }
 *   - `llm.chat` adapter threw → { code: -32000 }, `data` carries the
 *     reconstructable LLMError shape (see llmHost.ts errorDataFor)
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
    // Fire-and-forget from the readline loop's perspective: chat() can run
    // for minutes, and we must keep processing incoming lines (heartbeat
    // pings, llm.abort for THIS or other calls) while it's in flight.
    void (async () => {
      try {
        const result = await llmHost.handleChat(params);
        writeLine(makeResult(id, result));
      } catch (err) {
        writeLine(errorFromCaught(id, err));
      }
    })();
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
  llmHost.shutdownAll();
  flushAndExit(0);
});

process.stdin.on('error', (err) => {
  log('stdin error:', err);
  flushAndExit(1);
});
