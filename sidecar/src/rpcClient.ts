/**
 * Outbound reverse-RPC — sidecar→shell REQUESTS/NOTIFICATIONS (the mirror
 * image of `protocol.ts`'s `writeLine`/`makeResult`/`makeError`, which only
 * ever answer requests the SHELL sent us). P1-3a's `tool.invoke`/`hook.emit`
 * (subagentHost.ts) are the first consumers — see
 * docs/2026-07-19-phase1-p3-loop-migration-staging.md §2 "正式步 3a" item 7.
 *
 * ID scheme: outbound requests from THIS side mint STRING ids ('sq-N',
 * "sidecar request"), deliberately disjoint from the shell's own outbound
 * request ids (NUMBERS — see `sidecarManager.ts`'s `nextRequestId`). This
 * lets `main.ts`'s `handleMessage` and `sidecarManager.ts`'s `handleMessage`
 * both discriminate "is this message a response to MY outbound request?"
 * purely by `typeof id` without a shared registry — see both files'
 * matching JSDoc comments for the collision-freedom argument.
 *
 * `main.ts` calls `resolvePendingResponse()` when an incoming line has NO
 * `method` and a STRING `id` (i.e. it's a response to one of THIS module's
 * outbound requests, not a request FROM the shell).
 */
import { writeLine } from './protocol';

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  /** Bounded methods only — cleared as soon as the response (or teardown) arrives. */
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * #549: a reverse request whose response never arrives must not hang the run
 * forever. The shell now always answers an incoming request — `writeRpcMessage`
 * in `sidecarManager.ts` sends a small `-32000` error when the real result
 * cannot be delivered — but a lost line, a renderer teardown mid-flight or a
 * handler that never settles would otherwise strand this side silently.
 *
 * Methods that legitimately wait on a person or on a tool's own run time stay
 * unbounded: their liveness comes from that always-answering shell and from
 * process close (`rejectAllPendingRequests`).
 */
export const REVERSE_RPC_DEFAULT_TIMEOUT_MS = 60_000;

/**
 * `hook.emit` is NOT self-bounded: `lifecycleHooks.emitHook` awaits each
 * registered handler with no timeout of its own, and a `preToolCall` hook can
 * run several shell commands (each capped at 10s by `skillHooks.ts`, but any
 * number of them). It therefore gets a deliberately generous ceiling rather
 * than the 60s default (#549 R11).
 */
export const HOOK_EMIT_TIMEOUT_MS = 10 * 60_000;

export const UNBOUNDED_REVERSE_RPC_METHODS: ReadonlySet<string> = new Set([
  'tool.invoke',   // runs for as long as the tool itself does
  'native.invoke', // same, through the shell's native command host
  'approval.check',// waits on a person
]);

const REVERSE_RPC_TIMEOUT_OVERRIDES_MS: Readonly<Record<string, number>> = {
  'hook.emit': HOOK_EMIT_TIMEOUT_MS,
};

/** Milliseconds to wait for `method`'s response, or `undefined` for unbounded. */
function reverseRpcTimeoutMs(method: string): number | undefined {
  if (UNBOUNDED_REVERSE_RPC_METHODS.has(method)) return undefined;
  return REVERSE_RPC_TIMEOUT_OVERRIDES_MS[method] ?? REVERSE_RPC_DEFAULT_TIMEOUT_MS;
}

let counter = 0;
const pending = new Map<string, PendingRpc>();

function mintRequestId(): string {
  counter += 1;
  return `sq-${counter}`;
}

/**
 * P1-3b-2 flush-before-request hook (design doc §3's "flush-before-request
 * discipline"): an optional callback invoked at the START of every
 * `sendRequest()` call, BEFORE the request line is written. 3b-3 wires this
 * to the port-frame-coalescer's `flush()` so no buffered `agent.delta` frame
 * can ever be overtaken on the wire by a subsequent REQUEST (e.g.
 * `tool.invoke`/`hook.emit`) — the shell must see every delta frame the
 * causal chain up to that point implies (e.g. `setMessageToolCalls`) before
 * it sees the approval dialog the request triggers.
 *
 * Zero behavior when unset (the default) — every existing `sendRequest`
 * caller (subagentHost.ts's reverse ToolInvoker, hook.emit) is unaffected
 * until 3b-3 calls `setPreRequestFlush`.
 *
 * Deliberately NOT invoked from `sendNotification()` — notifications (the
 * delta frames themselves, `hook.notify`, `subagent.progress`, ...) don't
 * need the causal barrier; only REQUESTS (which the shell might act on
 * before later notifications arrive) do.
 */
let preRequestFlush: (() => void) | undefined;

/** Register (or clear, passing `undefined`) the pre-request flush hook — see `preRequestFlush`'s doc comment above. */
export function setPreRequestFlush(fn: (() => void) | undefined): void {
  preRequestFlush = fn;
}

/**
 * Send a request to the shell and await its response.
 *
 * Bounded by `reverseRpcTimeoutMs(method)` (#549): 60s by default, 10 minutes
 * for `hook.emit`, and no timeout at all for the user-/tool-duration methods in
 * `UNBOUNDED_REVERSE_RPC_METHODS` — callers of those (subagentHost.ts's
 * ToolInvoker, the native-invoke shim) rely on the shell's own tool-execution
 * semantics for bounding, and the whole `subagent.run` request itself has no
 * timeout either (mirrors llm.chat's unbounded-stream discipline). A timeout
 * rejects with `code: 'reverse_rpc_timeout'`; a late response for that id is
 * then ignored like any other unknown id.
 */
export function sendRequest(method: string, params: unknown): Promise<unknown> {
  preRequestFlush?.();
  const id = mintRequestId();
  return new Promise<unknown>((resolve, reject) => {
    const timeoutMs = reverseRpcTimeoutMs(method);
    const timer = timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          if (!pending.delete(id)) return;
          const err = new Error(`Shell request "${method}" timed out after ${timeoutMs}ms`) as Error & { code?: string };
          err.code = 'reverse_rpc_timeout';
          reject(err);
        }, timeoutMs);
    // A pending reverse RPC must never be the only reason this process stays up.
    (timer as { unref?: () => void } | undefined)?.unref?.();
    pending.set(id, { resolve, reject, timer });
    writeLine({ jsonrpc: '2.0', id, method, params });
  });
}

/** Send a fire-and-forget notification to the shell (no id, no response expected). */
export function sendNotification(method: string, params: unknown): void {
  writeLine({ jsonrpc: '2.0', method, params });
}

/** Called by main.ts's handleMessage on a response to one of OUR outbound requests (no `method`, string `id`). Unknown/late/duplicate ids are silently ignored. */
export function resolvePendingResponse(
  id: string,
  result: unknown,
  error?: { code: number; message: string; data?: unknown },
): void {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  if (entry.timer) clearTimeout(entry.timer);
  if (error) {
    const err = new Error(error.message) as Error & { code?: number; data?: unknown };
    err.code = error.code;
    err.data = error.data;
    entry.reject(err);
  } else {
    entry.resolve(result);
  }
}

/** Reject every pending outbound request — called from main.ts's shutdown/close handling so nothing hangs forever past process teardown. */
export function rejectAllPendingRequests(reason: Error): void {
  for (const entry of pending.values()) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.reject(reason);
  }
  pending.clear();
}
