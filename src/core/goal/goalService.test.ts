import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import type { Conversation } from '@/types';
import {
  blockConversationGoal,
  clearConversationGoal,
  completeConversationGoal,
  createConversationGoal,
  disarmConversationGoal,
  editConversationGoal,
  getGoal,
  pauseConversationGoal,
  recordConversationGoalRound,
  resumeConversationGoal,
  startConversationGoalRound,
} from './goalService';
import { getGoalActivation, isGoalArmed, resetGoalActivationsForTest } from './goalActivation';
import { goalRef, type GoalState } from './goalTypes';

function conversation(over: Partial<Conversation> = {}): Conversation {
  return { id: 'c1', title: 't', createdAt: 1, updatedAt: 1, status: 'idle', messages: [], ...over };
}

function seed(goal?: GoalState): void {
  useChatStore.setState({
    conversations: { c1: conversation(goal ? { goal } : {}) },
    conversationIndex: { c1: { id: 'c1', title: 't', createdAt: 1, updatedAt: 1, messageCount: 0, ...(goal ? { goal } : {}) } },
  } as never);
}

function mustCreate(objective = 'extract all contracts'): GoalState {
  const result = createConversationGoal('c1', { objective, maxRounds: 5 });
  if (!result.ok) throw new Error(result.error);
  return result.goal;
}

describe('goalService', () => {
  beforeEach(() => {
    resetGoalActivationsForTest();
    seed();
  });

  describe('round budget', () => {
    it('uses the built-in budget unless the caller names one', () => {
      expect(createConversationGoal('c1', { objective: 'o' })).toMatchObject({ ok: true, goal: { maxRounds: 256 } });
      clearConversationGoal('c1', goalRef(getGoal('c1')!));
      expect(createConversationGoal('c1', { objective: 'o', maxRounds: 12 })).toMatchObject({ ok: true, goal: { maxRounds: 12 } });
    });

    it('resuming a goal whose budget is spent adds more rounds; the caller\'s own number wins', () => {
      const goal = mustCreate();
      useChatStore.getState().setConversationGoal('c1', {
        ...goal, revision: goal.revision + 1, phase: 'blocked', roundsStarted: 5,
        blockedReason: { code: 'round-limit', message: '' },
      });
      expect(resumeConversationGoal('c1', goalRef(getGoal('c1')!))).toMatchObject({ ok: true, goal: { phase: 'active', maxRounds: 25 } });
      pauseConversationGoal('c1', goalRef(getGoal('c1')!));
      expect(resumeConversationGoal('c1', goalRef(getGoal('c1')!), 3)).toMatchObject({ ok: true, goal: { maxRounds: 28 } });
    });
  });

  describe('working time', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
    });
    afterEach(() => vi.useRealTimers());

    it('adds the time since the goal was armed on every write, and none while it is paused', () => {
      mustCreate();
      expect(getGoal('c1')?.elapsedMs).toBe(0);
      vi.setSystemTime(1_030_000);
      startConversationGoalRound('c1', goalRef(getGoal('c1')!));
      expect(getGoal('c1')?.elapsedMs).toBe(30_000);
      vi.setSystemTime(1_040_000);
      pauseConversationGoal('c1', goalRef(getGoal('c1')!));
      expect(getGoal('c1')?.elapsedMs).toBe(40_000);
      vi.setSystemTime(2_000_000);
      resumeConversationGoal('c1', goalRef(getGoal('c1')!));
      expect(getGoal('c1')?.elapsedMs).toBe(40_000);
      vi.setSystemTime(2_005_000);
      completeConversationGoal('c1', goalRef(getGoal('c1')!), { summary: 's', evidence: ['e'] });
      expect(getGoal('c1')?.elapsedMs).toBe(45_000);
    });

    it('keeps the time when automatic rounds stop without a phase change', () => {
      mustCreate();
      vi.setSystemTime(1_012_000);
      const before = getGoal('c1')!;
      disarmConversationGoal('c1', 'run-error');
      expect(getGoal('c1')).toMatchObject({ phase: 'active', elapsedMs: 12_000, revision: before.revision + 1 });
      vi.setSystemTime(1_500_000);
      disarmConversationGoal('c1', 'run-error');
      expect(getGoal('c1')?.elapsedMs).toBe(12_000);
    });
  });

  describe('create', () => {
    it('create writes the goal to the conversation AND its index entry, and arms it', () => {
      const goal = mustCreate();
      expect(getGoal('c1')).toEqual(goal);
      expect(useChatStore.getState().conversationIndex.c1.goal).toEqual(goal);
      expect(isGoalArmed('c1', goal.id)).toBe(true);
    });
  });

  describe('resume', () => {
    it('a goal restored from disk is disarmed until the user resumes it', () => {
      const restored: GoalState = {
        id: 'g-old', revision: 4, objective: 'o', phase: 'active', maxRounds: 10, roundsStarted: 2,
        consecutiveIdleRounds: 0, elapsedMs: 0, createdAt: 1, updatedAt: 1,
      };
      seed(restored);
      expect(getGoalActivation('c1', 'g-old')).toEqual({ goalId: 'g-old', armed: false, disarmReason: 'restart' });
      // The driver cannot start a round on a disarmed goal.
      expect(startConversationGoalRound('c1', goalRef(restored))).toMatchObject({ ok: false });
      const resumed = resumeConversationGoal('c1', goalRef(restored));
      expect(resumed.ok).toBe(true);
      expect(isGoalArmed('c1', 'g-old')).toBe(true);
    });

    it('resume refuses a goal that is already running', () => {
      const goal = mustCreate();
      expect(resumeConversationGoal('c1', goalRef(goal))).toMatchObject({ ok: false, error: 'invalid-transition' });
    });
  });

  describe('disarm', () => {
    it('pause / complete / block disarm; errors disarm without changing the phase', () => {
      let goal = mustCreate();
      disarmConversationGoal('c1', 'run-error');
      expect(getGoalActivation('c1', goal.id)).toMatchObject({ armed: false, disarmReason: 'run-error' });
      expect(getGoal('c1')?.phase).toBe('active');

      const resumed = resumeConversationGoal('c1', goalRef(goal));
      if (!resumed.ok) throw new Error(resumed.error);
      goal = resumed.goal;
      const paused = pauseConversationGoal('c1', goalRef(goal));
      expect(paused.ok).toBe(true);
      expect(getGoalActivation('c1', goal.id)).toMatchObject({ armed: false, disarmReason: 'inactive' });
    });
  });

  describe('complete / block', () => {
    it('complete records the settling run and disarms', () => {
      const goal = mustCreate();
      const done = completeConversationGoal('c1', goalRef(goal), { summary: 'all 300 extracted', evidence: ['summary.xlsx'] }, 'L9');
      expect(done).toMatchObject({ ok: true, goal: { phase: 'complete', settledLoopId: 'L9' } });
      expect(isGoalArmed('c1', goal.id)).toBe(false);
    });

    it('block disarms and keeps the reason', () => {
      const goal = mustCreate();
      const blocked = blockConversationGoal('c1', goalRef(goal), { code: 'model-reported', message: 'needs VPN' });
      expect(blocked).toMatchObject({ ok: true, goal: { phase: 'blocked', blockedReason: { message: 'needs VPN' } } });
      expect(isGoalArmed('c1', goal.id)).toBe(false);
    });
  });

  describe('compare-and-set', () => {
    it('a stale writer cannot overwrite a newer goal', () => {
      const goal = mustCreate();
      const edited = editConversationGoal('c1', goalRef(goal), 'changed scope');
      expect(edited.ok).toBe(true);
      expect(pauseConversationGoal('c1', goalRef(goal))).toEqual({ ok: false, error: 'stale-revision' });
      expect(getGoal('c1')?.phase).toBe('active');
    });
  });

  describe('rounds', () => {
    it('rounds count only while armed, and outcomes accumulate', () => {
      let goal = mustCreate();
      const started = startConversationGoalRound('c1', goalRef(goal));
      if (!started.ok) throw new Error(started.error);
      goal = started.goal;
      expect(goal.roundsStarted).toBe(1);
      const recorded = recordConversationGoalRound('c1', goalRef(goal), { hadToolCalls: false, teamDispatches: 4 });
      expect(recorded).toMatchObject({ ok: true, goal: { consecutiveIdleRounds: 1, teamDispatches: 4 } });
    });
  });

  describe('clear', () => {
    it('clear removes the goal from both copies and forgets the activation', () => {
      const goal = mustCreate();
      expect(clearConversationGoal('c1', goalRef(goal)).ok).toBe(true);
      expect(getGoal('c1')).toBeUndefined();
      expect(useChatStore.getState().conversationIndex.c1.goal).toBeUndefined();
      expect(getGoalActivation('c1', goal.id)?.armed).toBe(false);
    });
  });
});
