/**
 * User Input Queue — messages typed while a task runs, and internal loop wake-ups
 *
 * A user-authored entry is delivered one of two ways:
 * - `delivery: 'steer'`: plain text typed into the composer while a run the
 *   user is watching works. The entry is bound to that run (`runId`): only that
 *   run takes it, at its next model step after a tool step
 *   (`takeSteeringInputs`), and it becomes a user message inside that run.
 *   Whether the after-run queue is paused does not matter to the take.
 * - no `delivery`: it waits for the current run to finish and is then started
 *   as an independent run (`dequeueNextUserInput`).
 * A run reads steering between `beginSteeringRun` and `endSteeringRun`. When it
 * ends, every entry bound to it that it never took (the model was writing its
 * final answer, or the run stopped) becomes an entry of the second kind, so it
 * is started as its own turn afterwards and never steers a later run.
 * System entries (for example background-agent results) may be consumed by
 * the current loop at its next iteration.
 *
 * Every take and every change of an entry happens here, synchronously, so a
 * chip's ×, its "send after the task" action and the run's take can never
 * both win for the same entry.
 */

import type { ImageEditRequest } from '@/types/media';

/** Queued user input entry */
export interface QueuedInput {
  imageEditRequest?: ImageEditRequest;
  teamConfirmationRetryId?: string;
  /** Started from the confirmation strip: the run continues the current team task. */
  continuesTeamTask?: boolean;
  id: string;
  text: string;
  timestamp: number;
  /** System-injected messages (e.g. background agent results) — hidden from chat UI */
  isSystem?: boolean;
  /**
   * The running task takes this entry at its next step (see the module doc).
   * Absent: the entry waits for the run to end and starts its own turn.
   */
  delivery?: 'steer';
  /** With `delivery: 'steer'`: the run the entry was typed into, the only one that takes it. */
  runId?: string;
}

/**
 * Text that names its own route (`/skill …`, `@expert …`) starts its own run,
 * where the router can act on it; inside a running task it would arrive as
 * plain words. Everything else typed while a task runs steers that task.
 */
export function isSteerableText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && !trimmed.startsWith('/') && !trimmed.startsWith('@');
}

/** The transcript id of the user message a steered entry becomes; one entry, one message. */
export function steeredMessageId(queueId: string): string {
  return `steer-${queueId}`;
}

/** An entry the run it was typed into (`runId`) takes at its next step. */
export function isSteeringInput(item: Pick<QueuedInput, 'delivery' | 'isSystem'>): boolean {
  return item.delivery === 'steer' && !item.isSystem;
}

/** The same entry, waiting for the end of the run instead. */
function afterRun(item: QueuedInput): QueuedInput {
  if (item.delivery === undefined && item.runId === undefined) return item;
  const { delivery: _delivery, runId: _runId, ...rest } = item;
  return rest;
}

// Per-conversation input queues. Arrays are replaced (never mutated) on every
// change so getQueuedInputs() snapshots stay referentially stable for
// useSyncExternalStore.
const inputQueues = new Map<string, QueuedInput[]>();
const pausedUserQueues = new Set<string>();
// Per conversation, the run that reads steering right now (see beginSteeringRun).
const steeringRuns = new Map<string, string>();

const EMPTY_QUEUE: readonly QueuedInput[] = [];

// Listeners for queue state changes
const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Queue ownership mutations must remain committed even when a UI
      // observer is stale or faulty. Keep notifying the other subscribers.
    }
  }
}

/**
 * Enqueue a staged message for a running conversation. Plain user text steers
 * the run that reads steering in the conversation right now and is bound to
 * it (see the module doc); system wake-ups, team confirmation retries,
 * continuations of a team task, image edit requests (they carry their own
 * prepared pictures and start their own turn), text that names its own route and text typed
 * while no run reads steering (a scheduled, triggered or IM run, an `@expert`
 * run, the moment between two runs) wait for the end of the run. Returns the
 * entry, or undefined for empty text.
 */
export function enqueueUserInput(
  conversationId: string,
  text: string,
  isSystem?: boolean,
  teamConfirmationRetryId?: string,
  continuesTeamTask?: boolean,
  imageEditRequest?: ImageEditRequest,
): QueuedInput | undefined {
  if (!text.trim() && !imageEditRequest) return undefined;

  const steeringRun = steeringRuns.get(conversationId);
  const steer = steeringRun !== undefined
    && !isSystem && !teamConfirmationRetryId && !continuesTeamTask && !imageEditRequest && isSteerableText(text);
  const item: QueuedInput = {
    id: `qi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    text: text.trim() || imageEditRequest!.comments.map(comment => comment.text).filter(Boolean).join('\n'),
    timestamp: Date.now(),
    isSystem,
    ...(teamConfirmationRetryId ? { teamConfirmationRetryId } : {}),
    ...(continuesTeamTask ? { continuesTeamTask } : {}),
    ...(imageEditRequest ? { imageEditRequest: structuredClone(imageEditRequest) } : {}),
    ...(steer ? { delivery: 'steer' as const, runId: steeringRun } : {}),
  };
  const queue = inputQueues.get(conversationId) ?? [];
  inputQueues.set(conversationId, [...queue, item]);
  notifyListeners();
  return item;
}

/**
 * Same as `enqueueUserInput`, but uses a caller-supplied id instead of
 * generating one — P1-3B-4: the sidecar-run bridge needs the SHELL's
 * `QueuedInput.id` to survive across the process boundary (into the
 * sidecar's own bundled instance of this module) so `input.consumed` can
 * clear the exact shell-side entries (hence chips) that a sidecar-run loop
 * actually drained. Purely additive — `enqueueUserInput` itself is
 * untouched (same discipline as `scratchpadStore.ts`'s `addEntryWithId`).
 */
export function enqueueUserInputWithId(conversationId: string, id: string, text: string, isSystem?: boolean): void {
  if (!text.trim()) return;

  const queue = inputQueues.get(conversationId) ?? [];
  inputQueues.set(conversationId, [
    ...queue,
    {
      id,
      text: text.trim(),
      timestamp: Date.now(),
      isSystem,
    },
  ]);
  notifyListeners();
}

/**
 * Snapshot of the staged inputs for a conversation (for useSyncExternalStore).
 * Referentially stable between mutations; a shared empty array when none.
 */
export function getQueuedInputs(conversationId: string): readonly QueuedInput[] {
  return inputQueues.get(conversationId) ?? EMPTY_QUEUE;
}

/**
 * Cancel one staged input before the loop consumes it (the × on a queued pill).
 */
export function removeQueuedInput(conversationId: string, id: string): void {
  const queue = inputQueues.get(conversationId);
  if (!queue) return;
  const next = queue.filter((qi) => qi.id !== id);
  if (next.length === queue.length) return;
  if (next.length === 0) inputQueues.delete(conversationId);
  else inputQueues.set(conversationId, next);
  if (!next.some((qi) => !qi.isSystem)) pausedUserQueues.delete(conversationId);
  notifyListeners();
}

/**
 * Drain all queued inputs for a conversation.
 * Returns the queued messages and clears the queue.
 */
export function drainQueuedInputs(conversationId: string): QueuedInput[] {
  const queue = inputQueues.get(conversationId);
  if (!queue || queue.length === 0) return [];

  const items = [...queue];
  inputQueues.delete(conversationId);
  pausedUserQueues.delete(conversationId);
  notifyListeners();
  return items;
}

/**
 * Drain only system-authored entries, preserving user follow-ups and their FIFO
 * order. The active agent loop uses this selective drain so a queued user turn
 * can never be folded into the current run.
 */
export function drainSystemQueuedInputs(conversationId: string): QueuedInput[] {
  const queue = inputQueues.get(conversationId);
  if (!queue || queue.length === 0) return [];

  const systemInputs = queue.filter((qi) => qi.isSystem);
  if (systemInputs.length === 0) return [];

  const userInputs = queue.filter((qi) => !qi.isSystem);
  if (userInputs.length === 0) inputQueues.delete(conversationId);
  else inputQueues.set(conversationId, userInputs);
  notifyListeners();
  return systemInputs;
}

/**
 * Remove and return the oldest user-authored follow-up while leaving system
 * entries untouched. The shell dispatcher calls this only after the previous
 * run has reached a terminal state, then starts the returned item as a new run.
 * An entry typed into a run that still reads steering belongs to that run and
 * is not handed out here.
 */
export function dequeueNextUserInput(conversationId: string): QueuedInput | undefined {
  if (pausedUserQueues.has(conversationId)) return undefined;
  const queue = inputQueues.get(conversationId);
  if (!queue || queue.length === 0) return undefined;

  const steeringRun = steeringRuns.get(conversationId);
  const index = queue.findIndex((qi) => !qi.isSystem
    && !(isSteeringInput(qi) && steeringRun !== undefined && qi.runId === steeringRun));
  if (index < 0) return undefined;

  const item = queue[index];
  const next = [...queue.slice(0, index), ...queue.slice(index + 1)];
  if (next.length === 0) inputQueues.delete(conversationId);
  else inputQueues.set(conversationId, next);
  notifyListeners();
  return item;
}

/** Turn every entry bound to `runId` into one for after the run; true when one changed. */
function releaseRunEntries(conversationId: string, runId: string): boolean {
  const queue = inputQueues.get(conversationId);
  if (!queue?.some((qi) => qi.runId === runId)) return false;
  inputQueues.set(conversationId, queue.map((qi) => (qi.runId === runId ? afterRun(qi) : qi)));
  return true;
}

/**
 * Run `runId` reads steering in `conversationId` from now on: plain text typed
 * into the composer is bound to it. One run per conversation reads steering,
 * so the entries of a run registered before (it is over) become entries for
 * after the run. Called by the shell for a sidecar run the user is watching
 * when it registers the run, and by the agent loop itself for a run in this
 * process.
 */
export function beginSteeringRun(conversationId: string, runId: string): void {
  const previous = steeringRuns.get(conversationId);
  if (previous === runId) return;
  steeringRuns.set(conversationId, runId);
  if (previous !== undefined && releaseRunEntries(conversationId, previous)) notifyListeners();
}

/**
 * Run `runId` reads no more steering (it ended, was stopped, or goes on in a
 * way that has no next step of its own). Every entry bound to it becomes an
 * entry for after the run. Idempotent; a run that is no longer the
 * conversation's steering run still has its entries released.
 */
export function endSteeringRun(conversationId: string, runId: string): void {
  if (steeringRuns.get(conversationId) === runId) steeringRuns.delete(conversationId);
  if (releaseRunEntries(conversationId, runId)) notifyListeners();
}

/**
 * Remove and return, oldest first, the steering entries bound to `runId`.
 * Entries typed into another run are never handed out, and the after-run
 * pause does not hold them back: they were typed into the run that asks.
 * Synchronous: the removal and the answer are one step, so an entry is handed
 * out once.
 */
export function takeSteeringInputsNow(conversationId: string, runId: string): QueuedInput[] {
  const queue = inputQueues.get(conversationId);
  if (!queue || queue.length === 0) return [];
  const ours = (qi: QueuedInput) => isSteeringInput(qi) && qi.runId === runId;
  const taken = queue.filter(ours);
  if (taken.length === 0) return [];
  const rest = queue.filter((qi) => !ours(qi));
  if (rest.length === 0) inputQueues.delete(conversationId);
  else inputQueues.set(conversationId, rest);
  notifyListeners();
  return taken;
}

/**
 * The agent loop's take at a step boundary. In this process it is the
 * synchronous take above; the sidecar's copy of this module asks the shell,
 * which owns the queue (`sidecar/src/shims/userInputQueueRun.ts`).
 */
export async function takeSteeringInputs(conversationId: string, runId: string): Promise<QueuedInput[]> {
  return takeSteeringInputsNow(conversationId, runId);
}

/**
 * Put back entries that were taken but never became messages (the run stopped
 * between the take and the message). They go to the front, oldest first, with
 * their ids; an id already in the queue is not added twice. An entry whose run
 * no longer reads steering comes back as an entry for after the run. The
 * caller restores nothing into a conversation that no longer exists.
 */
export function restoreSteeringInputs(conversationId: string, items: readonly QueuedInput[]): void {
  if (items.length === 0) return;
  const queue = inputQueues.get(conversationId) ?? [];
  const ids = new Set(queue.map((qi) => qi.id));
  const steeringRun = steeringRuns.get(conversationId);
  const restored = items
    .filter((item) => !ids.has(item.id))
    .map((item) => (item.runId !== undefined && item.runId === steeringRun ? item : afterRun(item)));
  if (restored.length === 0) return;
  inputQueues.set(conversationId, [...restored, ...queue]);
  notifyListeners();
}

/**
 * A queued entry that was dequeued to start its own turn (the dispatcher's
 * hand-off after a run, or 「继续队列」) and met a run already live in the
 * conversation: it goes back to the front of the queue under its own id, as
 * an entry for after the run, so it steers nothing and is never bound to the
 * live run it was not typed into. The queue is not paused: the live run's
 * dispatcher starts it as its own turn when that run ends.
 */
export function requeueUserInput(conversationId: string, item: QueuedInput): void {
  const queue = inputQueues.get(conversationId) ?? [];
  inputQueues.set(conversationId, [afterRun(item), ...queue.filter((queued) => queued.id !== item.id)]);
  notifyListeners();
}

/**
 * The chip's "send after the task": the entry stops steering and waits for the
 * end of the run. A no-op when the run has already taken it.
 */
export function sendQueuedInputAfterRun(conversationId: string, id: string): void {
  const queue = inputQueues.get(conversationId);
  if (!queue) return;
  const index = queue.findIndex((qi) => qi.id === id && (qi.delivery !== undefined || qi.runId !== undefined));
  if (index < 0) return;
  const next = [...queue];
  next[index] = afterRun(queue[index]);
  inputQueues.set(conversationId, next);
  notifyListeners();
}

/**
 * Restore a user-authored item whose handoff failed before addMessage.
 *
 * The original id/timestamp and FIFO position are retained, and the queue is
 * paused before subscribers are notified so no observer can see the restored
 * item as runnable in the same turn. Replacing an accidental duplicate id
 * keeps retries idempotent.
 */
export function restoreDequeuedUserInput(conversationId: string, item: QueuedInput): void {
  const queue = inputQueues.get(conversationId) ?? [];
  const withoutDuplicate = queue.filter((queued) => queued.id !== item.id);
  if (item.isSystem) {
    inputQueues.set(conversationId, [item, ...withoutDuplicate]);
  } else {
    // It was being started as its own turn: it steers nothing now.
    inputQueues.set(conversationId, [afterRun(item), ...withoutDuplicate]);
    pausedUserQueues.add(conversationId);
  }
  notifyListeners();
}

/**
 * Pause user-authored follow-ups after the active run is interrupted: none is
 * started as its own turn until the user resumes. Steering entries are not
 * touched: those of the stopped run were released when it ended
 * (`endSteeringRun`), and a run that reads steering later still takes what
 * was typed into it.
 */
export function pauseUserInputQueue(conversationId: string): void {
  const queue = inputQueues.get(conversationId);
  if (!queue?.some((qi) => !qi.isSystem) || pausedUserQueues.has(conversationId)) return;
  pausedUserQueues.add(conversationId);
  // Replace the snapshot so useSyncExternalStore subscribers observe the
  // pause-state change even though the queue items themselves are unchanged.
  inputQueues.set(conversationId, [...queue]);
  notifyListeners();
}

/** Resume a queue explicitly; the caller owns dispatching its first item. */
export function resumeUserInputQueue(conversationId: string): void {
  if (!pausedUserQueues.delete(conversationId)) return;
  const queue = inputQueues.get(conversationId);
  if (queue) inputQueues.set(conversationId, [...queue]);
  notifyListeners();
}

export function isUserInputQueuePaused(conversationId: string): boolean {
  return pausedUserQueues.has(conversationId);
}

/**
 * Check if there are pending inputs for a conversation
 */
export function hasQueuedInputs(conversationId: string): boolean {
  const queue = inputQueues.get(conversationId);
  return !!queue && queue.length > 0;
}

/** Check whether the active loop has an internal wake-up waiting. */
export function hasSystemQueuedInputs(conversationId: string): boolean {
  return (inputQueues.get(conversationId) ?? EMPTY_QUEUE).some((qi) => qi.isSystem);
}

/**
 * Get the count of queued inputs for a conversation
 */
export function getQueuedInputCount(conversationId: string): number {
  return inputQueues.get(conversationId)?.length ?? 0;
}

/**
 * Clear the queue for a conversation (the conversation is deleted). Its run, if
 * one is stopping, reads no more steering either.
 */
export function clearInputQueue(conversationId: string): void {
  inputQueues.delete(conversationId);
  pausedUserQueues.delete(conversationId);
  steeringRuns.delete(conversationId);
  notifyListeners();
}

/**
 * Subscribe to queue state changes (for useSyncExternalStore)
 */
export function subscribeToInputQueue(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/**
 * Get a snapshot of all queue states (for useSyncExternalStore)
 */
export function getInputQueueSnapshot(): Map<string, number> {
  const snapshot = new Map<string, number>();
  for (const [convId, queue] of inputQueues) {
    if (queue.length > 0) {
      snapshot.set(convId, queue.length);
    }
  }
  return snapshot;
}
