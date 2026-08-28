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
 * P1-3a adds the `subagent.run` / `subagent.abort` protocol extension (see
 * subagentHost.ts) so a subagent's whole mini-loop runs in THIS process
 * instead of the webview — including a REVERSE channel (`tool.invoke` /
 * `hook.emit`, sidecar→shell requests) so tool execution and lifecycle
 * hooks still happen shell-side, unmoved (registry.ts's pathSafety /
 * permissions / approvals). See rpcClient.ts for the reverse-RPC transport
 * and subagentRunner.ts (shell side) for the full wire-protocol doc.
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
 *   - `subagent.run` → runs one subagent mini-loop to completion; see
 *     subagentHost.ts. The response settles only once the whole run
 *     finishes (or errors) — no progress notifications this phase (mirrors
 *     `llm.chat`'s "response settles at the end" shape, not its per-event
 *     streaming).
 *   - `agent.run` → P1-3B-3A: runs one MAIN agent-loop (`runAgentLoop`) to
 *     completion; see agentLoopHost.ts. Settles only once the whole run
 *     finishes — progress streams via `agent.delta` notifications
 *     (coalesced port-write frames, see portFrameCoalescer.ts) in the
 *     meantime, same shape discipline as `llm.chat`/`subagent.run`.
 * Notifications (no `id`):
 *   - `shutdown` → abort all active llm.chat calls, subagent.run calls, AND
 *     agent.run calls, reject all pending outbound (reverse-RPC) requests,
 *     flush stdout, exit(0)
 *   - `llm.abort` → abort one in-flight `llm.chat` call by callId (idempotent,
 *     unknown callId is a silent no-op)
 *   - `subagent.abort` → abort one in-flight `subagent.run` call by runId
 *     (idempotent, unknown runId is a silent no-op — same discipline as
 *     `llm.abort`)
 *   - `agent.abort` → P1-3B-3A: abort one in-flight `agent.run` call by
 *     runId (idempotent, unknown runId silent no-op, same discipline)
 *   - `agent.enqueueInput` → P1-3B-3B, extended by P1-3B-4: `{runId, message
 *     | userMessage, queueId?, isSystem?}` — the shell's queue forwarder
 *     relays internal system wake-ups into an active run (`message` +
 *     `queueId`, id-preserved for `input.consumed`). The `userMessage` shape
 *     remains accepted for backward compatibility, but new user follow-ups
 *     stay shell-side and start independent runs. Unknown runId silent drop.
 *   - `state.convPatch` → P1-3B-3A: `{runId, patch}` — scalar-field patch
 *     (workspacePath/title/activeSkills/model) applied to that run's
 *     conversation read-mirror. Unknown runId silent drop.
 *   - `state.execPatch` → P1-3B-3A item 6: `{runId, plannedSteps}` —
 *     applies `report_plan`'s planned-steps write (which bypasses
 *     ExecutionPort shell-side) to that run's execution mirror. Unknown
 *     runId silent drop.
 *   - `state.settings` → P1-3B-3A: `{settings}` — sidecar-GLOBAL settings
 *     mirror push (see settingsMirror.ts), NOT per-run/routed by runId.
 *   - `state.planMode` → P1-3B-3A: `{conversationId, mode}` — mirror-apply
 *     via planMode.ts's applyPlanModeState (does not re-notify the shell).
 * Notifications sidecar→shell:
 *   - `llm.event` → `{ callId, seq, event }` — one StreamEvent, coalesced
 *     (see eventCoalescer.ts)
 *   - `llm.chatMeta` → `{ callId, kind: 'maxTokensLimitDiscovered', limit }`
 *   - `input.consumed` → P1-3B-4: `{ runId, queueIds }` — the sidecar's
 *     `userInputQueue` shim (see shims/userInputQueueRun.ts) sends this
 *     after `agentLoop.ts` drains or clears queued inputs, naming exactly
 *     the ids it consumed. `agentLoopRunner.ts` removes the same system ids
 *     from the shell queue. Unknown runId silent drop.
 * Reverse requests sidecar→shell (see rpcClient.ts, subagentRunner.ts):
 *   - `tool.invoke` → `{ runId, toolName, input, context }`, response = the
 *     tool's `ToolResult`
 *   - `hook.emit` → `{ runId, event }` (only `preToolCall`, whose return
 *     value the loop consumes), response = the (possibly mutated) event
 * Reverse notifications sidecar→shell:
 *   - `hook.notify` → `{ runId, event }` (`subagentStart`/`subagentEnd`/
 *     `postToolCall` — fire-and-forget, return value never consumed)
 *   - `subagent.progress` → `{ runId, event }` (tool-start/tool-end/
 *     turn-complete — fire-and-forget, feeds the shell's execution-panel
 *     child-step visualization; see subagentHost.ts's `onProgress` wiring).
 *     Progress notifications and the `subagent.run` REQUEST's final
 *     response travel the same single ordered NDJSON stdout stream, so for
 *     a given run every progress notification is guaranteed to arrive
 *     before that run's final response.
 *
 * Errors (JSON-RPC 2.0 standard codes):
 *   - Malformed JSON on a line → { code: -32700 } (Parse error), id: null
 *   - Non-object / array message → { code: -32600 } (Invalid Request)
 *   - Unknown method (on a request, i.e. has an id) → { code: -32601 }
 *   - Invalid `llm.chat`/`llm.abort`/`fs.*`/`subagent.run`/`subagent.abort`
 *     params → { code: -32602 }
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
import { handleSubagentRun, handleSubagentAbort, shutdownAllSubagentRuns } from './subagentHost';
import {
  handleAgentRun,
  handleAgentStart,
  handleAgentGetState,
  handleAgentAbort,
  handleAgentEnqueueInput,
  handleStateConvPatch,
  handleStateExecPatch,
  handleStateSettings,
  handleStatePlanMode,
  shutdownAllAgentRuns,
} from './agentLoopHost';
import { resolvePendingResponse, rejectAllPendingRequests } from './rpcClient';
import { isAuthorizedE2ECrash } from './e2eCrashGate';
import { applyEnterpriseEntitlementSnapshot } from './enterpriseEntitlementMirror';
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

// P1-3d-2 follow-up — enforce the "stdout is protocol-only" invariant against
// BUNDLED src/ modules that call console.log directly. `memdir/extractor.ts`
// (`[Memory] …` lines) became reachable in-sidecar once 3d-2 un-stubbed it, and
// a stray console.log there writes to stdout — which the parent parses as an
// NDJSON JSON-RPC message, corrupting the stream. Redirect log/info/debug to
// stderr process-wide; the protocol itself writes via `writeLine` (direct
// process.stdout.write), never console, so this cannot affect real messages.
// This is defense-in-depth for the whole class, not just today's one offender.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

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

  const { id, method, params } = msg as JsonRpcRequest & {
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
  };

  // Response to one of OUR OWN outbound requests (tool.invoke / hook.emit —
  // see rpcClient.ts). No `method`, and `id` is a STRING (our mint scheme:
  // 'sq-N', deliberately disjoint from the shell's own numeric outbound-
  // request ids — see sidecarManager.ts's mirrored comment on the other
  // side of this same collision-freedom argument). Must be checked BEFORE
  // the notification/request dispatch below, since this kind of message has
  // no `method` at all.
  if (typeof method !== 'string' && typeof id === 'string') {
    const { result, error } = msg as { result?: unknown; error?: { code: number; message: string; data?: unknown } };
    resolvePendingResponse(id, result, error);
    return;
  }

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
    shutdownAllSubagentRuns();
    shutdownAllAgentRuns();
    rejectAllPendingRequests(new Error('Sidecar shutting down'));
    flushAndExit(0);
    return;
  }

  if (method === 'e2e.crash') {
    if (!isAuthorizedE2ECrash(params)) {
      if (!isNotification) writeLine(makeError(id, -32601, 'Method not found'));
      return;
    }
    log('authenticated E2E crash requested');
    process.exit(86);
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

  if (method === 'subagent.abort') {
    // Notification only — fire-and-forget, same discipline as llm.abort
    // (the shell has its own 5s defensive grace timer independent of this).
    try {
      handleSubagentAbort(params);
    } catch (err) {
      log('subagent.abort handler threw (ignored — notifications get no response)', err);
    }
    return;
  }

  if (method === 'subagent.run') {
    if (isNotification) return; // must be a request — a notification has no id to respond to
    // Async, same reasoning as llm.chat above: a subagent run can take
    // minutes and itself sends/awaits reverse-RPC requests (tool.invoke,
    // hook.emit) while in flight — the readline loop must keep processing
    // incoming lines (including THIS run's own tool.invoke responses,
    // and subagent.abort for this or other runs) the whole time.
    runAsyncRequest(id, () => handleSubagentRun(params));
    return;
  }

  if (method === 'agent.abort') {
    // Requests receive an ordering ACK so the shell can deterministically
    // finalize and fence late frames. Keep accepting the old notification
    // shape for rolling upgrades / backward compatibility.
    if (!isNotification) {
      runAsyncRequest(id, () => handleAgentAbort(params));
      return;
    }
    void handleAgentAbort(params)
      .catch((err) => log('agent.abort handler threw (ignored — notification has no response)', err));
    return;
  }

  if (method === 'agent.run') {
    if (isNotification) return; // must be a request — a notification has no id to respond to
    // Async, same reasoning as subagent.run above — a main-loop run can
    // stream for minutes and itself sends/awaits reverse-RPC requests
    // (tool.invoke, hook.emit, native.invoke, tool.list, ...) while in
    // flight, plus receives state.* push notifications for this or other
    // runs the whole time.
    runAsyncRequest(id, () => handleAgentRun(params));
    return;
  }

  if (method === 'agent.start') {
    if (isNotification) return;
    runAsyncRequest(id, () => Promise.resolve(handleAgentStart(params)));
    return;
  }

  if (method === 'run.getState') {
    if (isNotification) return;
    runAsyncRequest(id, () => Promise.resolve(handleAgentGetState(params)));
    return;
  }

  if (method === 'agent.enqueueInput') {
    // Notification only — P1-3B-3B's cross-process concurrency guard: stage
    // a message into an ALREADY-RUNNING run's userInputQueue instead of the
    // shell dispatching a second agent.run for the same conversationId.
    try {
      handleAgentEnqueueInput(params);
    } catch (err) {
      log('agent.enqueueInput handler threw (ignored — notifications get no response)', err);
    }
    return;
  }

  if (method === 'state.convPatch') {
    // Notification only — fire-and-forget scalar-field patch to a run's
    // conversation mirror (workspacePath/title/activeSkills/model).
    try {
      handleStateConvPatch(params);
    } catch (err) {
      log('state.convPatch handler threw (ignored — notifications get no response)', err);
    }
    return;
  }

  if (method === 'state.execPatch') {
    // Notification only — plannedSteps patch (P1-3B-3A item 6: report_plan
    // writes directly to the shell's taskExecutionStore, bypassing
    // ExecutionPort; this is the sidecar-side read-path fix).
    try {
      handleStateExecPatch(params);
    } catch (err) {
      log('state.execPatch handler threw (ignored — notifications get no response)', err);
    }
    return;
  }

  if (method === 'state.settings') {
    // Notification only — sidecar-GLOBAL settings mirror push (see
    // settingsMirror.ts), not per-run.
    try {
      handleStateSettings(params);
    } catch (err) {
      log('state.settings handler threw (ignored — notifications get no response)', err);
    }
    return;
  }

  if (method === 'state.enterpriseEntitlement') {
    // Global, live, fail-closed mirror used by Skill/MCP runtime gates.
    try {
      const entitlement = typeof params === 'object' && params !== null
        ? (params as { entitlement?: unknown }).entitlement
        : undefined;
      applyEnterpriseEntitlementSnapshot(entitlement);
    } catch (err) {
      applyEnterpriseEntitlementSnapshot(undefined);
      log('state.enterpriseEntitlement handler threw; access revoked', err);
    }
    return;
  }

  if (method === 'state.planMode') {
    // Notification only — mirror-apply (does not re-notify the shell back,
    // see planMode.ts's applyPlanModeState).
    try {
      handleStatePlanMode(params);
    } catch (err) {
      log('state.planMode handler threw (ignored — notifications get no response)', err);
    }
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
  shutdownAllSubagentRuns();
  shutdownAllAgentRuns();
  rejectAllPendingRequests(new Error('Sidecar process closing (stdin closed)'));
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
