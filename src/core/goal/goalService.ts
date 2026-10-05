import { useChatStore } from '@/stores/chatStore';
import {
  armGoal,
  clearGoalActivation,
  disarmGoal,
  isGoalArmed,
  startArmedClock,
  suspendArmedClock,
  takeArmedElapsed,
  type GoalDisarmReason,
} from './goalActivation';
import {
  addGoalElapsed,
  blockGoal,
  clampMaxRounds,
  completeGoal,
  createGoal,
  editGoal,
  pauseGoal,
  recordGoalRoundOutcome,
  resumeGoal,
  startGoalRound,
  type GoalTransitionResult,
} from './goalTransitions';
import {
  GOAL_DEFAULT_MAX_ROUNDS,
  GOAL_RESUME_EXTRA_ROUNDS,
  goalRef,
  type GoalBlockedReason,
  type GoalCompletion,
  type GoalRef,
  type GoalState,
} from './goalTypes';

/**
 * The single write path for goal state. UI, the /goal command, the model tool
 * and the round driver all go through here — nobody writes `conversation.goal`
 * directly — so the compare-and-set revision and the armed/disarmed flag stay
 * consistent with the durable phase.
 *
 * Every write also moves the working time counted since the goal was armed
 * into the goal's `elapsedMs`, so at most one round of it is lost to a crash.
 *
 * Shell-side only: it writes chatStore. The sidecar sees the result through
 * the conversation snapshot and `state.convPatch`.
 */

function generateGoalId(): string {
  return 'goal-' + Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

export function getGoal(conversationId: string): GoalState | undefined {
  return useChatStore.getState().conversations[conversationId]?.goal;
}

function commit(conversationId: string, result: GoalTransitionResult, now: number): GoalTransitionResult {
  if (!result.ok) return result;
  const elapsed = takeArmedElapsed(conversationId, result.goal.id, now);
  const goal = elapsed > 0 ? { ...result.goal, elapsedMs: result.goal.elapsedMs + elapsed } : result.goal;
  useChatStore.getState().setConversationGoal(conversationId, goal);
  return { ok: true, goal };
}

function disarmIfInactive(conversationId: string, result: GoalTransitionResult): GoalTransitionResult {
  if (result.ok && result.goal.phase !== 'active') disarmGoal(conversationId, result.goal.id, 'inactive');
  return result;
}

export function createConversationGoal(
  conversationId: string,
  input: { objective: string; maxRounds?: number; now?: number },
): GoalTransitionResult {
  const now = input.now ?? Date.now();
  const result = commit(conversationId, createGoal(getGoal(conversationId), {
    id: generateGoalId(),
    objective: input.objective,
    maxRounds: clampMaxRounds(input.maxRounds, GOAL_DEFAULT_MAX_ROUNDS),
    now,
  }), now);
  if (result.ok) armGoal(conversationId, result.goal.id, now);
  return result;
}

export function editConversationGoal(conversationId: string, ref: GoalRef, objective: string): GoalTransitionResult {
  const now = Date.now();
  return commit(conversationId, editGoal(getGoal(conversationId), ref, { objective, now }), now);
}

export function pauseConversationGoal(conversationId: string, ref: GoalRef): GoalTransitionResult {
  const now = Date.now();
  return disarmIfInactive(conversationId, commit(conversationId, pauseGoal(getGoal(conversationId), ref, now), now));
}

/**
 * Resume (or re-arm after a restart / run error). Fails when the goal is
 * already running. A goal whose round budget is spent gets
 * GOAL_RESUME_EXTRA_ROUNDS more unless the caller names its own amount.
 */
export function resumeConversationGoal(
  conversationId: string,
  ref: GoalRef,
  extraRounds?: number,
): GoalTransitionResult {
  const current = getGoal(conversationId);
  if (current && current.phase === 'active' && isGoalArmed(conversationId, current.id)) {
    return { ok: false, error: 'invalid-transition', phase: current.phase };
  }
  const extra = extraRounds ?? (current && current.roundsStarted >= current.maxRounds ? GOAL_RESUME_EXTRA_ROUNDS : undefined);
  const now = Date.now();
  const result = commit(conversationId, resumeGoal(current, ref, { now, extraRounds: extra }), now);
  if (result.ok) armGoal(conversationId, result.goal.id, now);
  return result;
}

export function completeConversationGoal(
  conversationId: string,
  ref: GoalRef,
  completion: GoalCompletion,
  loopId?: string,
): GoalTransitionResult {
  const now = Date.now();
  return disarmIfInactive(
    conversationId,
    commit(conversationId, completeGoal(getGoal(conversationId), ref, { completion, now, loopId }), now),
  );
}

export function blockConversationGoal(
  conversationId: string,
  ref: GoalRef,
  reason: GoalBlockedReason,
  loopId?: string,
): GoalTransitionResult {
  const now = Date.now();
  return disarmIfInactive(
    conversationId,
    commit(conversationId, blockGoal(getGoal(conversationId), ref, { reason, now, loopId }), now),
  );
}

export function clearConversationGoal(conversationId: string, ref: GoalRef): GoalTransitionResult {
  const current = getGoal(conversationId);
  if (!current) return { ok: false, error: 'no-goal' };
  if (current.id !== ref.id || current.revision !== ref.revision) return { ok: false, error: 'stale-revision' };
  useChatStore.getState().setConversationGoal(conversationId, undefined);
  clearGoalActivation(conversationId);
  return { ok: true, goal: current };
}

/** Driver: count one more automatic round. The goal must be active AND armed. */
export function startConversationGoalRound(conversationId: string, ref: GoalRef): GoalTransitionResult {
  const current = getGoal(conversationId);
  if (current && !isGoalArmed(conversationId, current.id)) {
    return { ok: false, error: 'invalid-transition', phase: current.phase };
  }
  const now = Date.now();
  const result = commit(conversationId, startGoalRound(current, ref, now), now);
  if (result.ok) startArmedClock(conversationId, result.goal.id, now);
  return result;
}

/** Driver: record a finished round's outcome (idle streak, team hand-offs). */
export function recordConversationGoalRound(
  conversationId: string,
  ref: GoalRef,
  outcome: { hadToolCalls: boolean; teamDispatches: number },
): GoalTransitionResult {
  const now = Date.now();
  return commit(conversationId, recordGoalRoundOutcome(getGoal(conversationId), ref, { ...outcome, now }), now);
}

/** True while the goal is working through automatic rounds (active and armed). */
export function isGoalDrivingConversation(conversationId: string): boolean {
  const goal = getGoal(conversationId);
  return goal?.phase === 'active' && isGoalArmed(conversationId, goal.id);
}

/** Move the working time counted since the last write into the goal. */
function settleElapsed(conversationId: string, current: GoalState): void {
  const now = Date.now();
  const elapsed = takeArmedElapsed(conversationId, current.id, now);
  if (elapsed <= 0) return;
  const result = addGoalElapsed(current, goalRef(current), { elapsedMs: elapsed, now });
  if (result.ok) useChatStore.getState().setConversationGoal(conversationId, result.goal);
}

/** Stop automatic rounds without changing the durable phase (DSH semantics for errors / user stop). */
export function disarmConversationGoal(conversationId: string, reason: GoalDisarmReason): void {
  const current = getGoal(conversationId);
  if (!current) return;
  settleElapsed(conversationId, current);
  disarmGoal(conversationId, current.id, reason);
}

/**
 * Driver: the goal stays armed but nothing runs until the next round starts
 * (it waits for a retry), so that wait is not working time.
 */
export function suspendConversationGoalClock(conversationId: string): void {
  const current = getGoal(conversationId);
  if (!current) return;
  settleElapsed(conversationId, current);
  suspendArmedClock(conversationId, current.id);
}
