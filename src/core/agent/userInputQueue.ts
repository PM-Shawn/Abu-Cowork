/**
 * User Input Queue — staged follow-ups and internal loop wake-ups
 *
 * User-authored entries wait for the current run to finish and are then started
 * as independent runs. System entries (for example background-agent results)
 * may still be consumed by the current loop at its next iteration.
 */

/** Queued user input entry */
export interface QueuedInput {
  id: string;
  text: string;
  timestamp: number;
  /** System-injected messages (e.g. background agent results) — hidden from chat UI */
  isSystem?: boolean;
}

// Per-conversation input queues. Arrays are replaced (never mutated) on every
// change so getQueuedInputs() snapshots stay referentially stable for
// useSyncExternalStore.
const inputQueues = new Map<string, QueuedInput[]>();
const pausedUserQueues = new Set<string>();

const EMPTY_QUEUE: readonly QueuedInput[] = [];

// Listeners for queue state changes
const listeners = new Set<() => void>();

function notifyListeners() {
  listeners.forEach(fn => fn());
}

/**
 * Enqueue a staged message for a running conversation.
 */
export function enqueueUserInput(conversationId: string, text: string, isSystem?: boolean): void {
  if (!text.trim()) return;

  const queue = inputQueues.get(conversationId) ?? [];
  inputQueues.set(conversationId, [
    ...queue,
    {
      id: `qi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      text: text.trim(),
      timestamp: Date.now(),
      isSystem,
    },
  ]);
  notifyListeners();
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
 */
export function dequeueNextUserInput(conversationId: string): QueuedInput | undefined {
  if (pausedUserQueues.has(conversationId)) return undefined;
  const queue = inputQueues.get(conversationId);
  if (!queue || queue.length === 0) return undefined;

  const index = queue.findIndex((qi) => !qi.isSystem);
  if (index < 0) return undefined;

  const item = queue[index];
  const next = [...queue.slice(0, index), ...queue.slice(index + 1)];
  if (next.length === 0) inputQueues.delete(conversationId);
  else inputQueues.set(conversationId, next);
  notifyListeners();
  return item;
}

/** Pause user-authored follow-ups after the active run is interrupted. */
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
 * Clear the queue for a conversation (e.g. on cancel/reset)
 */
export function clearInputQueue(conversationId: string): void {
  inputQueues.delete(conversationId);
  pausedUserQueues.delete(conversationId);
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
