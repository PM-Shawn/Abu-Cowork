import { describe, it, expect } from 'vitest';
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
} from './goalTransitions';
import { GOAL_MAX_MAX_ROUNDS, GOAL_OBJECTIVE_MAX_CHARS, goalRef, type GoalState } from './goalTypes';

function active(over: Partial<GoalState> = {}): GoalState {
  return {
    id: 'g1',
    revision: 1,
    objective: 'extract all contracts',
    phase: 'active',
    maxRounds: 10,
    roundsStarted: 0,
    consecutiveIdleRounds: 0,
    elapsedMs: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function ok(result: ReturnType<typeof createGoal>): GoalState {
  if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
  return result.goal;
}

describe('goalTransitions', () => {
  describe('createGoal', () => {
    it('creates an active goal at revision 1 with no rounds used', () => {
      const goal = ok(createGoal(undefined, { id: 'g1', objective: '  do it  ', maxRounds: 5, now: 7 }));
      expect(goal).toMatchObject({ id: 'g1', revision: 1, objective: 'do it', phase: 'active', maxRounds: 5, roundsStarted: 0 });
    });

    it('rejects an empty objective', () => {
      expect(createGoal(undefined, { id: 'g', objective: '   ', maxRounds: 5, now: 1 })).toEqual({ ok: false, error: 'empty-objective' });
    });

    it('truncates an over-long objective', () => {
      const goal = ok(createGoal(undefined, { id: 'g', objective: 'x'.repeat(GOAL_OBJECTIVE_MAX_CHARS + 50), maxRounds: 5, now: 1 }));
      expect(goal.objective).toHaveLength(GOAL_OBJECTIVE_MAX_CHARS);
    });

    it('refuses to overwrite an unfinished goal but may replace a completed one', () => {
      for (const phase of ['active', 'paused', 'blocked'] as const) {
        expect(createGoal(active({ phase }), { id: 'g2', objective: 'new', maxRounds: 5, now: 1 }))
          .toEqual({ ok: false, error: 'invalid-transition', phase });
      }
      expect(ok(createGoal(active({ phase: 'complete' }), { id: 'g2', objective: 'new', maxRounds: 5, now: 1 })).id).toBe('g2');
    });
  });

  describe('compare-and-set', () => {
    it('rejects a stale revision or another goal id', () => {
      const goal = active({ revision: 3 });
      expect(pauseGoal(goal, { id: 'g1', revision: 2 }, 1)).toEqual({ ok: false, error: 'stale-revision' });
      expect(pauseGoal(goal, { id: 'other', revision: 3 }, 1)).toEqual({ ok: false, error: 'stale-revision' });
      expect(pauseGoal(undefined, { id: 'g1', revision: 3 }, 1)).toEqual({ ok: false, error: 'no-goal' });
    });

    it('bumps the revision on every successful write', () => {
      const goal = active({ revision: 4 });
      expect(ok(pauseGoal(goal, goalRef(goal), 9))).toMatchObject({ revision: 5, updatedAt: 9 });
    });
  });

  describe('editGoal', () => {
    it('keeps phase and rounds, replaces the objective', () => {
      const goal = active({ phase: 'paused', roundsStarted: 3 });
      expect(ok(editGoal(goal, goalRef(goal), { objective: 'changed', now: 2 }))).toMatchObject({ objective: 'changed', phase: 'paused', roundsStarted: 3 });
    });

    it('cannot edit a completed goal', () => {
      const goal = active({ phase: 'complete' });
      expect(editGoal(goal, goalRef(goal), { objective: 'x', now: 2 })).toMatchObject({ ok: false, error: 'invalid-transition' });
    });
  });

  describe('pause / resume', () => {
    it('pauses only an active goal', () => {
      const paused = active({ phase: 'paused' });
      expect(pauseGoal(paused, goalRef(paused), 1)).toMatchObject({ ok: false, error: 'invalid-transition' });
    });

    it('resumes paused and blocked goals and clears the blocked reason and idle streak', () => {
      const blocked = active({ phase: 'blocked', blockedReason: { code: 'no-progress', message: 'm' }, consecutiveIdleRounds: 2 });
      const resumed = ok(resumeGoal(blocked, goalRef(blocked), { now: 2 }));
      expect(resumed.phase).toBe('active');
      expect(resumed.blockedReason).toBeUndefined();
      expect(resumed.consecutiveIdleRounds).toBe(0);
    });

    it('needs extra rounds once the budget is spent', () => {
      const spent = active({ phase: 'blocked', roundsStarted: 10, maxRounds: 10 });
      expect(resumeGoal(spent, goalRef(spent), { now: 2 })).toMatchObject({ ok: false, error: 'rounds-exhausted' });
      expect(ok(resumeGoal(spent, goalRef(spent), { now: 2, extraRounds: 5 })).maxRounds).toBe(15);
    });

    it('never raises the budget past the hard cap', () => {
      const goal = active({ phase: 'paused', maxRounds: GOAL_MAX_MAX_ROUNDS - 1 });
      expect(ok(resumeGoal(goal, goalRef(goal), { now: 2, extraRounds: 50 })).maxRounds).toBe(GOAL_MAX_MAX_ROUNDS);
    });

    it('cannot resume a completed goal', () => {
      const goal = active({ phase: 'complete' });
      expect(resumeGoal(goal, goalRef(goal), { now: 2 })).toMatchObject({ ok: false, error: 'invalid-transition' });
    });
  });

  describe('completeGoal', () => {
    it('requires a summary and at least one piece of evidence', () => {
      const goal = active();
      expect(completeGoal(goal, goalRef(goal), { completion: { summary: 'done', evidence: [] }, now: 2 }))
        .toEqual({ ok: false, error: 'missing-evidence' });
      expect(completeGoal(goal, goalRef(goal), { completion: { summary: ' ', evidence: ['a.xlsx'] }, now: 2 }))
        .toEqual({ ok: false, error: 'missing-evidence' });
      expect(completeGoal(goal, goalRef(goal), { completion: { summary: 'done', evidence: ['  '] }, now: 2 }))
        .toEqual({ ok: false, error: 'missing-evidence' });
    });

    it('records the completion and the settling run', () => {
      const goal = active();
      const done = ok(completeGoal(goal, goalRef(goal), { completion: { summary: 'done', evidence: ['a.xlsx'] }, now: 2, loopId: 'L1' }));
      expect(done).toMatchObject({ phase: 'complete', completion: { summary: 'done', evidence: ['a.xlsx'] }, settledLoopId: 'L1' });
    });

    it('only completes an active goal', () => {
      const goal = active({ phase: 'paused' });
      expect(completeGoal(goal, goalRef(goal), { completion: { summary: 'd', evidence: ['e'] }, now: 2 }))
        .toMatchObject({ ok: false, error: 'invalid-transition' });
    });
  });

  describe('blockGoal', () => {
    it('blocks an active goal with a reason', () => {
      const goal = active();
      expect(ok(blockGoal(goal, goalRef(goal), { reason: { code: 'model-reported', message: ' need login ' }, now: 2, loopId: 'L2' })))
        .toMatchObject({ phase: 'blocked', blockedReason: { code: 'model-reported', message: 'need login' }, settledLoopId: 'L2' });
    });

    it('drops blocked-only fields when the goal leaves the blocked phase', () => {
      const goal = active({ phase: 'blocked', blockedReason: { code: 'round-limit', message: 'x' }, settledLoopId: 'L' });
      const resumed = ok(resumeGoal(goal, goalRef(goal), { now: 3, extraRounds: 1 }));
      expect(resumed.blockedReason).toBeUndefined();
      expect(resumed.settledLoopId).toBeUndefined();
    });
  });

  describe('rounds', () => {
    it('counts a round only for an active goal with budget left', () => {
      const goal = active({ roundsStarted: 9, maxRounds: 10 });
      const started = ok(startGoalRound(goal, goalRef(goal), 2));
      expect(started.roundsStarted).toBe(10);
      expect(startGoalRound(started, goalRef(started), 3)).toMatchObject({ ok: false, error: 'rounds-exhausted' });
      const paused = active({ phase: 'paused' });
      expect(startGoalRound(paused, goalRef(paused), 2)).toMatchObject({ ok: false, error: 'invalid-transition' });
    });

    it('tracks the idle streak and resets it on a round with tool calls', () => {
      const goal = active();
      const idle = ok(recordGoalRoundOutcome(goal, goalRef(goal), { hadToolCalls: false, teamDispatches: 0, now: 2 }));
      const idle2 = ok(recordGoalRoundOutcome(idle, goalRef(idle), { hadToolCalls: false, teamDispatches: 0, now: 3 }));
      expect(idle2.consecutiveIdleRounds).toBe(2);
      const busy = ok(recordGoalRoundOutcome(idle2, goalRef(idle2), { hadToolCalls: true, teamDispatches: 0, now: 4 }));
      expect(busy.consecutiveIdleRounds).toBe(0);
    });

    it('accumulates team hand-offs across rounds (the per-run cap resets each round)', () => {
      const goal = active();
      const r1 = ok(recordGoalRoundOutcome(goal, goalRef(goal), { hadToolCalls: true, teamDispatches: 30, now: 2 }));
      const r2 = ok(recordGoalRoundOutcome(r1, goalRef(r1), { hadToolCalls: true, teamDispatches: 40, now: 3 }));
      expect(r2.teamDispatches).toBe(70);
      const plain = ok(recordGoalRoundOutcome(goal, goalRef(goal), { hadToolCalls: true, teamDispatches: 0, now: 2 }));
      expect(plain.teamDispatches).toBeUndefined();
    });
  });

  describe('addGoalElapsed', () => {
    it('adds working time in any phase and bumps the revision', () => {
      const goal = active();
      const added = ok(addGoalElapsed(goal, goalRef(goal), { elapsedMs: 1500, now: 2 }));
      expect(added).toMatchObject({ elapsedMs: 1500, revision: goal.revision + 1, phase: 'active' });
      const paused = ok(pauseGoal(added, goalRef(added), 3));
      expect(ok(addGoalElapsed(paused, goalRef(paused), { elapsedMs: 500, now: 4 })).elapsedMs).toBe(2000);
    });

    it('ignores a negative amount and rejects a stale reference', () => {
      const goal = active();
      expect(ok(addGoalElapsed(goal, goalRef(goal), { elapsedMs: -10, now: 2 })).elapsedMs).toBe(0);
      expect(addGoalElapsed(goal, { id: goal.id, revision: goal.revision + 1 }, { elapsedMs: 10, now: 2 }))
        .toMatchObject({ ok: false, error: 'stale-revision' });
    });
  });

  describe('clampMaxRounds', () => {
    it('clamps to [1, hard cap] and falls back for non-numbers', () => {
      expect(clampMaxRounds(0, 256)).toBe(1);
      expect(clampMaxRounds(99999, 256)).toBe(GOAL_MAX_MAX_ROUNDS);
      expect(clampMaxRounds(undefined, 256)).toBe(256);
      expect(clampMaxRounds(Number.NaN, 256)).toBe(256);
      expect(clampMaxRounds(12.7, 256)).toBe(12);
    });
  });
});
