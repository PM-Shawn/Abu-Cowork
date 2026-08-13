/**
 * Sidecar-local wrapper around `src/core/agent/userInputQueue.ts` — P1-3B-4
 * (see P1-3B-4-QUEUEINPUT-FIX-REPORT.md for the full root-cause writeup).
 *
 * ── Why this shim exists ─────────────────────────────────────────────────
 * Before this batch, `userInputQueue.ts` was NOT in `SHIM_TARGETS` — it got
 * bundled into the sidecar as a plain module, giving the sidecar its OWN
 * separate module instance (a fresh, empty `inputQueues` Map) disconnected
 * from the shell's. `agentLoop.ts` (which now runs INSIDE the sidecar for a
 * sidecar-dispatched run) calls the queue APIs against THAT instance, never
 * the shell's — so an internal wake-up staged shell-side was previously never
 * seen by the sidecar loop.
 *
 * The fix keeps the shell's `userInputQueue` as the single UI source of
 * truth (the chip). This shim does NOT reimplement the queue — it wraps the
 * REAL bundled module (same "real forwarding shim" shape as
 * `conversationStorageRun.ts`/`abortRegistryRun.ts`) and adds exactly one
 * side effect: after the loop drains/clears queued entries from the
 * sidecar's own (real, unchanged) queue instance, notify the shell via
 * `input.consumed { runId, queueIds }` so `agentLoopRunner.ts`'s handler can
 * `removeQueuedInput` the same system ids from the shell's queue.
 *
 * The other half of the bridge — NEW entries reaching the sidecar's queue in
 * the first place — is NOT this shim's job:
 *   - System wake-up at dispatch: `agentLoopHost.ts` seeds this
 *     module (via `enqueueUserInputWithId`, id-preserving) from the
 *     `agent.run` params' `queuedInputs` snapshot, BEFORE the loop starts —
 *     so `agentLoop.ts`'s selective system drain picks it up.
 *   - Mid-run system add: `agentLoopHost.ts`'s `handleAgentEnqueueInput` (the
 *     `agent.enqueueInput` notification handler) calls
 *     `enqueueUserInputWithId` directly when the shell's forwarder
 *     (`agentLoopRunner.ts`) observes a new shell-queue entry for a
 *     conversation with an active sidecar `RunSession`. User follow-ups are
 *     never forwarded; the shell starts them as independent runs.
 *
 * ── runId resolution for the consumed-notify ─────────────────────────────
 * `drainQueuedInputs`/`clearInputQueue` take a `conversationId`, not a
 * `runId` — but `input.consumed` needs `runId` (the shell's session
 * registry is keyed by runId, same as every other reverse notification in
 * this batch — `agent.delta`/`state.convPatch`/etc.). Resolved from the
 * ambient `agentRunContext` AsyncLocalStorage (the loop always runs inside
 * `agentRunContext.run(...)`, per-run — see that module's doc) via
 * `.getStore()` directly (NOT `getCurrentAgentRunContext()`, which THROWS
 * outside a run scope) — this shim must be defensive, not throw: a queue
 * drain/clear reached from outside a live run context (shouldn't happen in
 * practice, since `agentLoop.ts` only calls these from inside the loop,
 * which only ever executes inside `agentRunContext.run()`) simply skips the
 * notify rather than crashing the drain/clear itself.
 */
import {
  enqueueUserInput as realEnqueueUserInput,
  enqueueUserInputWithId as realEnqueueUserInputWithId,
  getQueuedInputs as realGetQueuedInputs,
  removeQueuedInput as realRemoveQueuedInput,
  drainQueuedInputs as realDrainQueuedInputs,
  drainSystemQueuedInputs as realDrainSystemQueuedInputs,
  hasQueuedInputs as realHasQueuedInputs,
  hasSystemQueuedInputs as realHasSystemQueuedInputs,
  getQueuedInputCount as realGetQueuedInputCount,
  isUserInputQueuePaused as realIsUserInputQueuePaused,
  pauseUserInputQueue as realPauseUserInputQueue,
  resumeUserInputQueue as realResumeUserInputQueue,
  clearInputQueue as realClearInputQueue,
  subscribeToInputQueue as realSubscribeToInputQueue,
  getInputQueueSnapshot as realGetInputQueueSnapshot,
  type QueuedInput,
} from '@/core/agent/userInputQueue';
import { sendNotification } from '../rpcClient';
import { agentRunContext } from '../agentRunContext';

export type { QueuedInput };

// Straight pass-throughs — real behavior, unchanged. `agentLoop.ts` reads/
// writes the SAME underlying (sidecar-local) Map via these; only
// `drainQueuedInputs`/`clearInputQueue` below get the additional
// consumed-notify side effect.
export const enqueueUserInput = realEnqueueUserInput;
export const enqueueUserInputWithId = realEnqueueUserInputWithId;
export const getQueuedInputs = realGetQueuedInputs;
export const removeQueuedInput = realRemoveQueuedInput;
export const hasQueuedInputs = realHasQueuedInputs;
export const hasSystemQueuedInputs = realHasSystemQueuedInputs;
export const getQueuedInputCount = realGetQueuedInputCount;
export const isUserInputQueuePaused = realIsUserInputQueuePaused;
export const pauseUserInputQueue = realPauseUserInputQueue;
export const resumeUserInputQueue = realResumeUserInputQueue;
export const subscribeToInputQueue = realSubscribeToInputQueue;
export const getInputQueueSnapshot = realGetInputQueueSnapshot;

function notifyConsumed(queueIds: string[]): void {
  if (queueIds.length === 0) return;
  const runId = agentRunContext.getStore()?.runId;
  if (!runId) return; // outside a run context — defensive no-op, see module doc.
  sendNotification('input.consumed', { runId, queueIds });
}

/** Real drain — then notify the shell of exactly the ids this call drained. */
export function drainQueuedInputs(conversationId: string): QueuedInput[] {
  const items = realDrainQueuedInputs(conversationId);
  notifyConsumed(items.map((qi) => qi.id));
  return items;
}

/** Selective real drain used by the active loop; user follow-ups stay shell-side. */
export function drainSystemQueuedInputs(conversationId: string): QueuedInput[] {
  const items = realDrainSystemQueuedInputs(conversationId);
  notifyConsumed(items.map((qi) => qi.id));
  return items;
}

/** Real clear — `clearInputQueue` itself returns nothing, so snapshot the ids BEFORE clearing to know what was consumed. */
export function clearInputQueue(conversationId: string): void {
  const items = realGetQueuedInputs(conversationId);
  const queueIds = items.map((qi) => qi.id);
  realClearInputQueue(conversationId);
  notifyConsumed(queueIds);
}
