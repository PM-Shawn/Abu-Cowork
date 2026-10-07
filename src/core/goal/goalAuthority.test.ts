import { describe, it, expect } from 'vitest';
import { checkGoalAuthority, isHumanInitiatedRun } from './goalAuthority';
import type { Conversation, Message } from '@/types';
import type { GoalState } from './goalTypes';

function conv(messages: Message[], over: Partial<Conversation> = {}): Conversation {
  return { id: 'c1', title: 't', createdAt: 1, updatedAt: 1, status: 'running', messages, ...over };
}

const human: Message = { id: 'u1', role: 'user', content: 'finish all of them', timestamp: 1, loopId: 'L1' };
const goalRound: Message = {
  id: 'u2', role: 'user', content: '<goal_round/>', timestamp: 2, loopId: 'L2', isSystem: true,
  goalRound: { goalId: 'g1', revision: 3, round: 2 },
};
const wakeUp: Message = { id: 'u3', role: 'user', content: 'background result', timestamp: 3, loopId: 'L3', isSystem: true };

const goal = (roundsStarted: number): GoalState => ({
  id: 'g1', revision: 3, objective: 'o', phase: 'active', maxRounds: 10, roundsStarted,
  consecutiveIdleRounds: 0, elapsedMs: 0, createdAt: 1, updatedAt: 1,
});

const userRun = (loopId: string) => ({ initiatedBy: 'user' as const, interactionMode: 'foreground' as const, loopId });

describe('goalAuthority', () => {
  describe('isHumanInitiatedRun', () => {
    it('is true only for a run whose own user message is a real, visible one', () => {
      const c = conv([human, goalRound, wakeUp]);
      expect(isHumanInitiatedRun(userRun('L1'), c)).toBe(true);
      expect(isHumanInitiatedRun(userRun('L2'), c)).toBe(false);
      expect(isHumanInitiatedRun(userRun('L3'), c)).toBe(false);
      expect(isHumanInitiatedRun(userRun('L-unknown'), c)).toBe(false);
    });

    it('is false for automation and background runs', () => {
      const c = conv([human]);
      expect(isHumanInitiatedRun({ initiatedBy: 'automation', loopId: 'L1' }, c)).toBe(false);
      expect(isHumanInitiatedRun({ initiatedBy: 'user', interactionMode: 'background', loopId: 'L1' }, c)).toBe(false);
    });
  });

  describe('checkGoalAuthority', () => {
    const c = conv([human, goalRound]);

    it('denies every action, even get, to a delegated subagent / team member', () => {
      for (const action of ['get', 'create', 'complete'] as const) {
        expect(checkGoalAuthority(action, { ...userRun('L1'), agentRunId: 'sar-1' }, c, goal(5))).toBe('subagent');
      }
    });

    it('lets create / edit / pause / resume through only in a human-initiated run', () => {
      for (const action of ['create', 'edit', 'pause', 'resume'] as const) {
        expect(checkGoalAuthority(action, userRun('L1'), c, goal(0))).toBeUndefined();
        expect(checkGoalAuthority(action, userRun('L2'), c, goal(0))).toBe('needs-human-turn');
      }
    });

    it('lets an automatic round complete its goal', () => {
      expect(checkGoalAuthority('complete', userRun('L2'), c, goal(1))).toBeUndefined();
    });

    it('allows block only after enough rounds', () => {
      expect(checkGoalAuthority('block', userRun('L2'), c, goal(2))).toBe('block-too-early');
      expect(checkGoalAuthority('block', userRun('L2'), c, goal(3))).toBeUndefined();
    });

    it('keeps goal mode out of scheduled / trigger / IM / read-only conversations', () => {
      for (const over of [{ scheduledTaskId: 's' }, { triggerId: 't' }, { imChannelId: 'i' }, { readOnly: true }]) {
        expect(checkGoalAuthority('create', userRun('L1'), conv([human], over), undefined)).toBe('automated-conversation');
      }
      expect(checkGoalAuthority('get', userRun('L1'), conv([human], { imChannelId: 'i' }), undefined)).toBeUndefined();
    });
  });
});
