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
}

let counter = 0;
const pending = new Map<string, PendingRpc>();

function mintRequestId(): string {
  counter += 1;
  return `sq-${counter}`;
}

/** Send a request to the shell and await its response. No timeout here — callers (subagentHost.ts's ToolInvoker) rely on the shell's own tool-execution semantics for bounding, and the whole subagent.run request itself has no timeout either (mirrors llm.chat's unbounded-stream discipline). */
export function sendRequest(method: string, params: unknown): Promise<unknown> {
  const id = mintRequestId();
  return new Promise<unknown>((resolve, reject) => {
    pending.set(id, { resolve, reject });
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
    entry.reject(reason);
  }
  pending.clear();
}
