/**
 * Whether a conversation's goal may start automatic rounds right now.
 *
 * Deliberately process-local and never persisted: the map is empty on every
 * app start, so a goal restored from disk is always disarmed and can only run
 * again after the user resumes it ("opening a conversation does not authorize
 * spending" — same rule as DSH's goal driver). Any unexpected event (run
 * error, output-token exhaustion, user stop) disarms and records why, so the
 * UI can say why automatic rounds stopped.
 */

export type GoalDisarmReason =
  /** Restored from disk / app restarted — never armed in this process. */
  | 'restart'
  /** A round ended in an error (including output-token recovery exhaustion). */
  | 'run-error'
  /** The user stopped the running round. */
  | 'user-stop'
  /** The goal left the active phase (paused, blocked, completed, cleared). */
  | 'inactive';

/** A round ended in a retryable error; the driver starts another one at `at`. */
export interface GoalRetry {
  /** 1-based attempt number. */
  attempt: number;
  at: number;
}

export interface GoalActivation {
  goalId: string;
  armed: boolean;
  disarmReason?: GoalDisarmReason;
  /**
   * While armed: start of the working time not yet added to the goal's
   * `elapsedMs`. Absent while the goal waits for a retry — nothing runs then.
   */
  armedAt?: number;
  /** While armed: the pending automatic retry, if any. */
  retry?: GoalRetry;
  /** While armed: automatic retries made since the last run that did not fail. */
  retriesUsed?: number;
}

type Listener = (conversationId: string) => void;

const activations = new Map<string, GoalActivation>();
const listeners = new Set<Listener>();

function notify(conversationId: string): void {
  for (const listener of listeners) listener(conversationId);
}

/** Activation for the conversation's CURRENT goal; a stale entry for another goal reads as disarmed-by-restart. */
export function getGoalActivation(conversationId: string, goalId: string | undefined): GoalActivation | undefined {
  if (!goalId) return undefined;
  const entry = activations.get(conversationId);
  if (entry && entry.goalId === goalId) return entry;
  return { goalId, armed: false, disarmReason: 'restart' };
}

export function isGoalArmed(conversationId: string, goalId: string | undefined): boolean {
  return getGoalActivation(conversationId, goalId)?.armed === true;
}

export function armGoal(conversationId: string, goalId: string, now: number): void {
  activations.set(conversationId, { goalId, armed: true, armedAt: now });
  notify(conversationId);
}

/**
 * Working time since the goal was armed (or since the last call), in ms, and
 * restart the count from `now`. 0 when the goal is not armed.
 */
export function takeArmedElapsed(conversationId: string, goalId: string, now: number): number {
  const entry = activations.get(conversationId);
  if (!entry || entry.goalId !== goalId || !entry.armed || entry.armedAt === undefined) return 0;
  const elapsed = Math.max(0, now - entry.armedAt);
  activations.set(conversationId, { ...entry, armedAt: now });
  return elapsed;
}

/** Stop counting working time for an armed goal until `startArmedClock`. */
export function suspendArmedClock(conversationId: string, goalId: string): void {
  const entry = activations.get(conversationId);
  if (!entry || entry.goalId !== goalId || !entry.armed || entry.armedAt === undefined) return;
  const next: GoalActivation = { ...entry };
  delete next.armedAt;
  activations.set(conversationId, next);
}

/** Count working time from `now` for an armed goal whose clock is suspended. */
export function startArmedClock(conversationId: string, goalId: string, now: number): void {
  const entry = activations.get(conversationId);
  if (!entry || entry.goalId !== goalId || !entry.armed || entry.armedAt !== undefined) return;
  activations.set(conversationId, { ...entry, armedAt: now });
}

/**
 * Record (or drop, with `undefined`) the pending automatic retry of an armed
 * goal. Recording one also counts it; the count lasts until `resetGoalRetries`
 * or until the goal is armed or disarmed again.
 */
export function setGoalRetry(conversationId: string, goalId: string, retry: GoalRetry | undefined): void {
  const entry = activations.get(conversationId);
  if (!entry || entry.goalId !== goalId || !entry.armed) return;
  if (!retry && !entry.retry) return;
  const next: GoalActivation = { ...entry };
  if (retry) {
    next.retry = retry;
    next.retriesUsed = retry.attempt;
  } else {
    delete next.retry;
  }
  activations.set(conversationId, next);
  notify(conversationId);
}

/** A run did not fail: the next failure starts the retry sequence over. */
export function resetGoalRetries(conversationId: string, goalId: string): void {
  const entry = activations.get(conversationId);
  if (!entry || entry.goalId !== goalId || !entry.armed) return;
  if (!entry.retry && entry.retriesUsed === undefined) return;
  const next: GoalActivation = { ...entry };
  delete next.retry;
  delete next.retriesUsed;
  activations.set(conversationId, next);
  notify(conversationId);
}

export function disarmGoal(conversationId: string, goalId: string, reason: GoalDisarmReason): void {
  const entry = activations.get(conversationId);
  if (entry && entry.goalId === goalId && !entry.armed && entry.disarmReason === reason) return;
  activations.set(conversationId, { goalId, armed: false, disarmReason: reason });
  notify(conversationId);
}

export function clearGoalActivation(conversationId: string): void {
  if (!activations.delete(conversationId)) return;
  notify(conversationId);
}

/** Subscribe to activation changes (for useSyncExternalStore). Returns an unsubscribe function. */
export function subscribeGoalActivation(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test-only reset. */
export function resetGoalActivationsForTest(): void {
  activations.clear();
}
