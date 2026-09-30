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

export interface GoalActivation {
  goalId: string;
  armed: boolean;
  disarmReason?: GoalDisarmReason;
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

export function armGoal(conversationId: string, goalId: string): void {
  activations.set(conversationId, { goalId, armed: true });
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
