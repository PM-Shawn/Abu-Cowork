import { useChatStore } from '@/stores/chatStore';
import { armGoal, clearGoalActivation, disarmGoal, isGoalArmed, type GoalDisarmReason } from './goalActivation';
import {
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
 * Shell-side only: it writes chatStore. The sidecar sees the result through
 * the conversation snapshot and `state.convPatch`.
 */

function generateGoalId(): string {
  return 'goal-' + Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

export function getGoal(conversationId: string): GoalState | undefined {
  return useChatStore.getState().conversations[conversationId]?.goal;
}

function commit(conversationId: string, result: GoalTransitionResult): GoalTransitionResult {
  if (result.ok) useChatStore.getState().setConversationGoal(conversationId, result.goal);
  return result;
}

function disarmIfInactive(conversationId: string, result: GoalTransitionResult): GoalTransitionResult {
  if (result.ok && result.goal.phase !== 'active') disarmGoal(conversationId, result.goal.id, 'inactive');
  return result;
}

export function createConversationGoal(
  conversationId: string,
  input: { objective: string; maxRounds?: number; now?: number },
): GoalTransitionResult {
  const result = commit(conversationId, createGoal(getGoal(conversationId), {
    id: generateGoalId(),
    objective: input.objective,
    maxRounds: clampMaxRounds(input.maxRounds, GOAL_DEFAULT_MAX_ROUNDS),
    now: input.now ?? Date.now(),
  }));
  if (result.ok) armGoal(conversationId, result.goal.id);
  return result;
}

export function editConversationGoal(conversationId: string, ref: GoalRef, objective: string): GoalTransitionResult {
  return commit(conversationId, editGoal(getGoal(conversationId), ref, { objective, now: Date.now() }));
}

export function pauseConversationGoal(conversationId: string, ref: GoalRef): GoalTransitionResult {
  return disarmIfInactive(conversationId, commit(conversationId, pauseGoal(getGoal(conversationId), ref, Date.now())));
}

/** Resume (or re-arm after a restart / run error). Fails when the goal is already running. */
export function resumeConversationGoal(
  conversationId: string,
  ref: GoalRef,
  extraRounds?: number,
): GoalTransitionResult {
  const current = getGoal(conversationId);
  if (current && current.phase === 'active' && isGoalArmed(conversationId, current.id)) {
    return { ok: false, error: 'invalid-transition', phase: current.phase };
  }
  const result = commit(conversationId, resumeGoal(current, ref, { now: Date.now(), extraRounds }));
  if (result.ok) armGoal(conversationId, result.goal.id);
  return result;
}

export function completeConversationGoal(
  conversationId: string,
  ref: GoalRef,
  completion: GoalCompletion,
  loopId?: string,
): GoalTransitionResult {
  return disarmIfInactive(
    conversationId,
    commit(conversationId, completeGoal(getGoal(conversationId), ref, { completion, now: Date.now(), loopId })),
  );
}

export function blockConversationGoal(
  conversationId: string,
  ref: GoalRef,
  reason: GoalBlockedReason,
  loopId?: string,
): GoalTransitionResult {
  return disarmIfInactive(
    conversationId,
    commit(conversationId, blockGoal(getGoal(conversationId), ref, { reason, now: Date.now(), loopId })),
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
  return commit(conversationId, startGoalRound(current, ref, Date.now()));
}

/** Driver: record a finished round's outcome (idle streak, team hand-offs). */
export function recordConversationGoalRound(
  conversationId: string,
  ref: GoalRef,
  outcome: { hadToolCalls: boolean; teamDispatches: number },
): GoalTransitionResult {
  return commit(conversationId, recordGoalRoundOutcome(getGoal(conversationId), ref, { ...outcome, now: Date.now() }));
}

/** Stop automatic rounds without changing the durable phase (DSH semantics for errors / user stop). */
export function disarmConversationGoal(conversationId: string, reason: GoalDisarmReason): void {
  const current = getGoal(conversationId);
  if (current) disarmGoal(conversationId, current.id, reason);
}
