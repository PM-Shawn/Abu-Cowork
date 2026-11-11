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
 * ── Steering: the take goes to the shell ─────────────────────────────────
 * User entries typed while a task runs live only in the shell's queue. When
 * the loop reaches a step boundary it calls `takeSteeringInputs`, which here
 * asks the shell (`input.takeSteering { runId }`, handled by
 * `agentLoopRunner.ts`'s `handleTakeSteering`). The shell removes the entries
 * and answers with them in one synchronous step, so a chip's × or its "send
 * after the task" and the take can never both win, and nothing is forwarded
 * ahead of time that could later go stale in this process. A failed or
 * malformed answer takes nothing. `restoreSteeringInputs` is a no-op here:
 * the shell remembers what it handed out and, when it finalizes the run,
 * puts back every entry whose message never reached it.
 *
 * Which run a typed message is bound to is decided in the shell as well: it
 * opens a run the user is watching for steering when it registers the run.
 * `beginSteeringRun` therefore only updates this process's copy; the loop's
 * `endSteeringRun` (the run goes on without steps of its own, was stopped, or
 * ended) also tells the shell (`input.steeringEnded { runId }`), so a message
 * the run will never read stops saying it joins the next step at once.
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
  dequeueNextUserInput as realDequeueNextUserInput,
  restoreDequeuedUserInput as realRestoreDequeuedUserInput,
  requeueUserInput as realRequeueUserInput,
  takeSteeringInputsNow as realTakeSteeringInputsNow,
  beginSteeringRun as realBeginSteeringRun,
  endSteeringRun as realEndSteeringRun,
  sendQueuedInputAfterRun as realSendQueuedInputAfterRun,
  isSteerableText as realIsSteerableText,
  isSteeringInput as realIsSteeringInput,
  steeredMessageId as realSteeredMessageId,
  type QueuedInput,
} from '@/core/agent/userInputQueue';
import { sendNotification, sendRequest } from '../rpcClient';
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
export const dequeueNextUserInput = realDequeueNextUserInput;
export const restoreDequeuedUserInput = realRestoreDequeuedUserInput;
export const requeueUserInput = realRequeueUserInput;
export const takeSteeringInputsNow = realTakeSteeringInputsNow;
export const beginSteeringRun = realBeginSteeringRun;
export const sendQueuedInputAfterRun = realSendQueuedInputAfterRun;
export const isSteerableText = realIsSteerableText;
export const isSteeringInput = realIsSteeringInput;
export const steeredMessageId = realSteeredMessageId;

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

function isTakenItem(value: unknown): value is { id: string; text: string; timestamp: number } {
  if (!value || typeof value !== 'object') return false;
  const item = value as { id?: unknown; text?: unknown; timestamp?: unknown };
  return typeof item.id === 'string' && item.id.length > 0
    && typeof item.text === 'string' && item.text.trim().length > 0
    && typeof item.timestamp === 'number' && Number.isFinite(item.timestamp);
}

/**
 * The step-boundary take, answered by the shell (see the module doc). Never
 * rejects: outside a run, on a transport failure or on a malformed answer it
 * takes nothing, and whatever the shell did hand out comes back as a chip when
 * the shell finalizes the run.
 */
export async function takeSteeringInputs(_conversationId: string, _runId: string): Promise<QueuedInput[]> {
  const runId = agentRunContext.getStore()?.runId;
  if (!runId) return [];
  let reply: unknown;
  try {
    reply = await sendRequest('input.takeSteering', { runId });
  } catch {
    return [];
  }
  const items = (reply as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.filter(isTakenItem).map((item) => ({
    id: item.id,
    text: item.text,
    timestamp: item.timestamp,
    delivery: 'steer' as const,
  }));
}

/**
 * The run reads no more steering (see the module doc): this process's copy
 * releases its entries and the shell is told, so the chips of the messages it
 * will not read say they wait for the end of the task. Outside a run nothing
 * is sent; the shell releases a run's entries when it settles anyway.
 */
export function endSteeringRun(conversationId: string, runId: string): void {
  realEndSteeringRun(conversationId, runId);
  const ambientRunId = agentRunContext.getStore()?.runId;
  if (!ambientRunId) return;
  sendNotification('input.steeringEnded', { runId: ambientRunId });
}

/** No-op in the sidecar: the shell restores undelivered entries itself (see the module doc). */
export function restoreSteeringInputs(_conversationId: string, _items: readonly QueuedInput[]): void {}
