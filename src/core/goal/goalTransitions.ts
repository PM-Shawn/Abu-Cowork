import {
  GOAL_COMPLETION_EVIDENCE_MAX_CHARS,
  GOAL_COMPLETION_EVIDENCE_MAX_ITEMS,
  GOAL_COMPLETION_SUMMARY_MAX_CHARS,
  GOAL_DEFAULT_MAX_ROUNDS,
  GOAL_MAX_MAX_ROUNDS,
  GOAL_MIN_MAX_ROUNDS,
  GOAL_OBJECTIVE_MAX_CHARS,
  type GoalBlockedReason,
  type GoalCompletion,
  type GoalPhase,
  type GoalRef,
  type GoalState,
} from './goalTypes';

/**
 * Pure goal state machine. Every function takes the current goal (or none)
 * and returns either the next goal or a typed rejection — no store, clock or
 * id source of its own, so the whole transition table is unit-testable.
 */

export type GoalTransitionError =
  | 'no-goal'
  | 'stale-revision'
  | 'invalid-transition'
  | 'empty-objective'
  | 'rounds-exhausted'
  | 'missing-evidence';

export type GoalTransitionResult =
  | { ok: true; goal: GoalState }
  | { ok: false; error: GoalTransitionError; phase?: GoalPhase };

function fail(error: GoalTransitionError, phase?: GoalPhase): GoalTransitionResult {
  return { ok: false, error, ...(phase ? { phase } : {}) };
}

function checkRef(goal: GoalState | undefined, ref: GoalRef): GoalTransitionResult | GoalState {
  if (!goal) return fail('no-goal');
  if (goal.id !== ref.id || goal.revision !== ref.revision) return fail('stale-revision');
  return goal;
}

function next(goal: GoalState, now: number, patch: Partial<GoalState>): GoalTransitionResult {
  const updated: GoalState = { ...goal, ...patch, revision: goal.revision + 1, updatedAt: now };
  if (updated.phase !== 'blocked') delete updated.blockedReason;
  if (updated.phase !== 'complete') delete updated.completion;
  if (updated.phase !== 'complete' && updated.phase !== 'blocked') delete updated.settledLoopId;
  return { ok: true, goal: updated };
}

export function normalizeObjective(objective: string): string {
  return objective.trim().slice(0, GOAL_OBJECTIVE_MAX_CHARS);
}

export function clampMaxRounds(value: number | undefined, fallback: number): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(GOAL_MAX_MAX_ROUNDS, Math.max(GOAL_MIN_MAX_ROUNDS, raw));
}

export function createGoal(
  current: GoalState | undefined,
  input: { id: string; objective: string; maxRounds: number; now: number },
): GoalTransitionResult {
  // One goal per conversation: a finished goal may be replaced, a live one
  // must be cleared (or edited) first so nothing is silently overwritten.
  if (current && current.phase !== 'complete') return fail('invalid-transition', current.phase);
  const objective = normalizeObjective(input.objective);
  if (!objective) return fail('empty-objective');
  return {
    ok: true,
    goal: {
      id: input.id,
      revision: 1,
      objective,
      phase: 'active',
      maxRounds: clampMaxRounds(input.maxRounds, GOAL_DEFAULT_MAX_ROUNDS),
      roundsStarted: 0,
      consecutiveIdleRounds: 0,
      elapsedMs: 0,
      createdAt: input.now,
      updatedAt: input.now,
    },
  };
}

export function editGoal(
  current: GoalState | undefined,
  ref: GoalRef,
  input: { objective: string; now: number },
): GoalTransitionResult {
  const checked = checkRef(current, ref);
  if ('ok' in checked) return checked;
  if (checked.phase === 'complete') return fail('invalid-transition', checked.phase);
  const objective = normalizeObjective(input.objective);
  if (!objective) return fail('empty-objective');
  return next(checked, input.now, { objective });
}

export function pauseGoal(current: GoalState | undefined, ref: GoalRef, now: number): GoalTransitionResult {
  const checked = checkRef(current, ref);
  if ('ok' in checked) return checked;
  if (checked.phase !== 'active') return fail('invalid-transition', checked.phase);
  return next(checked, now, { phase: 'paused' });
}

/**
 * Resume a paused or blocked goal (or re-arm an active one — the caller arms;
 * the durable state only needs a revision bump so stale rounds are fenced).
 * `extraRounds` raises the budget, required once it is spent.
 */
export function resumeGoal(
  current: GoalState | undefined,
  ref: GoalRef,
  input: { now: number; extraRounds?: number },
): GoalTransitionResult {
  const checked = checkRef(current, ref);
  if ('ok' in checked) return checked;
  if (checked.phase === 'complete') return fail('invalid-transition', checked.phase);
  const extra = Math.max(0, Math.floor(input.extraRounds ?? 0));
  const maxRounds = Math.min(GOAL_MAX_MAX_ROUNDS, checked.maxRounds + extra);
  if (checked.roundsStarted >= maxRounds) return fail('rounds-exhausted', checked.phase);
  return next(checked, input.now, { phase: 'active', maxRounds, consecutiveIdleRounds: 0 });
}

export function completeGoal(
  current: GoalState | undefined,
  ref: GoalRef,
  input: { completion: GoalCompletion; now: number; loopId?: string },
): GoalTransitionResult {
  const checked = checkRef(current, ref);
  if ('ok' in checked) return checked;
  if (checked.phase !== 'active') return fail('invalid-transition', checked.phase);
  const summary = input.completion.summary.trim().slice(0, GOAL_COMPLETION_SUMMARY_MAX_CHARS);
  const evidence = input.completion.evidence
    .map((item) => item.trim().slice(0, GOAL_COMPLETION_EVIDENCE_MAX_CHARS))
    .filter(Boolean)
    .slice(0, GOAL_COMPLETION_EVIDENCE_MAX_ITEMS);
  if (!summary || evidence.length === 0) return fail('missing-evidence');
  return next(checked, input.now, {
    phase: 'complete',
    completion: { summary, evidence },
    ...(input.loopId ? { settledLoopId: input.loopId } : {}),
  });
}

export function blockGoal(
  current: GoalState | undefined,
  ref: GoalRef,
  input: { reason: GoalBlockedReason; now: number; loopId?: string },
): GoalTransitionResult {
  const checked = checkRef(current, ref);
  if ('ok' in checked) return checked;
  if (checked.phase !== 'active') return fail('invalid-transition', checked.phase);
  return next(checked, input.now, {
    phase: 'blocked',
    blockedReason: { code: input.reason.code, message: input.reason.message.trim().slice(0, 1000) },
    ...(input.loopId ? { settledLoopId: input.loopId } : {}),
  });
}

/** Add working time to the goal. Allowed in every phase: the time was already spent. */
export function addGoalElapsed(
  current: GoalState | undefined,
  ref: GoalRef,
  input: { elapsedMs: number; now: number },
): GoalTransitionResult {
  const checked = checkRef(current, ref);
  if ('ok' in checked) return checked;
  return next(checked, input.now, { elapsedMs: checked.elapsedMs + Math.max(0, input.elapsedMs) });
}

/** Count one more automatic round. Only an active goal with budget left may start one. */
export function startGoalRound(current: GoalState | undefined, ref: GoalRef, now: number): GoalTransitionResult {
  const checked = checkRef(current, ref);
  if ('ok' in checked) return checked;
  if (checked.phase !== 'active') return fail('invalid-transition', checked.phase);
  if (checked.roundsStarted >= checked.maxRounds) return fail('rounds-exhausted', checked.phase);
  return next(checked, now, { roundsStarted: checked.roundsStarted + 1 });
}

/** Record how a finished round went; drives the no-progress and team budgets. */
export function recordGoalRoundOutcome(
  current: GoalState | undefined,
  ref: GoalRef,
  input: { hadToolCalls: boolean; teamDispatches: number; now: number },
): GoalTransitionResult {
  const checked = checkRef(current, ref);
  if ('ok' in checked) return checked;
  const patch: Partial<GoalState> = {
    consecutiveIdleRounds: input.hadToolCalls ? 0 : checked.consecutiveIdleRounds + 1,
  };
  if (input.teamDispatches > 0 || checked.teamDispatches !== undefined) {
    patch.teamDispatches = (checked.teamDispatches ?? 0) + Math.max(0, input.teamDispatches);
  }
  return next(checked, input.now, patch);
}
