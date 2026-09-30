import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Conversation, Message } from '@/types';

const runAgentLoopDispatched = vi.fn((..._args: unknown[]) => Promise.resolve({ reason: 'completed' }));
const onDispatchSettled = vi.fn((..._args: unknown[]) => () => {});
vi.mock('@/core/agent/agentLoopRunner', () => ({
  runAgentLoopDispatched: (...args: unknown[]) => runAgentLoopDispatched(...args),
  onDispatchSettled: (...args: unknown[]) => onDispatchSettled(...args),
}));
const runningInSidecar = vi.fn((_id: string) => false);
vi.mock('@/core/agent/sidecarRunPredicate', () => ({
  isConversationRunningInSidecar: (id: string) => runningInSidecar(id),
}));
const notifyGoalBlocked = vi.fn();
vi.mock('@/utils/notifications', () => ({
  notifyGoalBlocked: (...args: unknown[]) => notifyGoalBlocked(...args),
}));
const queuedInputs = vi.fn((_id: string): unknown[] => []);
vi.mock('@/core/agent/userInputQueue', () => ({
  getQueuedInputs: (id: string) => queuedInputs(id),
}));

import { useChatStore } from '@/stores/chatStore';
import {
  decideAfterSettle,
  handleDispatchSettled,
  installGoalDriver,
  kickGoalDriver,
  resetGoalDriverForTest,
  summarizeRoundMessages,
} from './goalDriver';
import { disarmGoal, getGoalActivation, isGoalArmed, resetGoalActivationsForTest } from './goalActivation';
import { createConversationGoal, getGoal } from './goalService';
import { GOAL_TEAM_MAX_DISPATCHES, type GoalState } from './goalTypes';

function goal(over: Partial<GoalState> = {}): GoalState {
  return {
    id: 'g1', revision: 2, objective: 'o', phase: 'active', maxRounds: 10, roundsStarted: 1,
    consecutiveIdleRounds: 0, createdAt: 1, updatedAt: 1, ...over,
  };
}

function seed(over: Partial<Conversation> = {}): void {
  useChatStore.setState({
    conversations: { c1: { id: 'c1', title: 't', createdAt: 1, updatedAt: 1, status: 'completed', messages: [], ...over } },
    conversationIndex: { c1: { id: 'c1', title: 't', createdAt: 1, updatedAt: 1, messageCount: 0 } },
  } as never);
}

function appendMessages(messages: Message[]): void {
  const conv = useChatStore.getState().conversations.c1;
  useChatStore.setState({ conversations: { c1: { ...conv, messages: [...conv.messages, ...messages] } } } as never);
}

const toolTurn = (name: string, input: Record<string, unknown> = {}): Message => ({
  id: `a-${name}-${Math.floor(Object.keys(input).length)}`, role: 'assistant', content: '', timestamp: 1,
  toolCalls: [{ id: 't', name, input }],
});
const textTurn: Message = { id: 'a-text', role: 'assistant', content: 'done for now', timestamp: 1 };

describe('goalDriver', () => {
  describe('decideAfterSettle', () => {
    const base = { goal: goal(), armed: true, reason: 'completed' as const, eligible: true, isTeam: false };

    it('continues an active, armed goal with budget left', () => {
      expect(decideAfterSettle(base)).toEqual({ kind: 'continue' });
      expect(decideAfterSettle({ ...base, reason: 'max_turns' })).toEqual({ kind: 'continue' });
    });

    it('ignores a missing, inactive or disarmed goal', () => {
      expect(decideAfterSettle({ ...base, goal: undefined })).toEqual({ kind: 'ignore' });
      for (const phase of ['paused', 'blocked', 'complete'] as const) {
        expect(decideAfterSettle({ ...base, goal: goal({ phase }) })).toEqual({ kind: 'ignore' });
      }
      expect(decideAfterSettle({ ...base, armed: false })).toEqual({ kind: 'ignore' });
    });

    it('maps run outcomes the DSH way: error disarms, stop pauses, waiting waits, enqueued is ignored', () => {
      expect(decideAfterSettle({ ...base, reason: 'error' })).toEqual({ kind: 'disarm', reason: 'run-error' });
      expect(decideAfterSettle({ ...base, reason: 'aborted' })).toEqual({ kind: 'pause' });
      expect(decideAfterSettle({ ...base, reason: 'awaiting_user' })).toEqual({ kind: 'wait' });
      expect(decideAfterSettle({ ...base, reason: 'enqueued' })).toEqual({ kind: 'ignore' });
    });

    it('blocks on the idle streak, the team hand-off budget and the round budget', () => {
      expect(decideAfterSettle({ ...base, goal: goal({ consecutiveIdleRounds: 2 }) })).toEqual({ kind: 'block', code: 'no-progress' });
      expect(decideAfterSettle({ ...base, isTeam: true, goal: goal({ teamDispatches: GOAL_TEAM_MAX_DISPATCHES }) }))
        .toEqual({ kind: 'block', code: 'team-dispatch-limit' });
      // The team budget only applies to team conversations.
      expect(decideAfterSettle({ ...base, goal: goal({ teamDispatches: GOAL_TEAM_MAX_DISPATCHES }) })).toEqual({ kind: 'continue' });
      expect(decideAfterSettle({ ...base, goal: goal({ roundsStarted: 10, maxRounds: 10 }) })).toEqual({ kind: 'block', code: 'round-limit' });
    });

    it('does nothing for an ineligible (automated) conversation', () => {
      expect(decideAfterSettle({ ...base, eligible: false })).toEqual({ kind: 'ignore' });
    });
  });

  describe('summarizeRoundMessages', () => {
    it('counts tool calls, ignoring manage_goal bookkeeping', () => {
      expect(summarizeRoundMessages([textTurn])).toEqual({ hadToolCalls: false, teamDispatches: 0 });
      expect(summarizeRoundMessages([toolTurn('manage_goal')])).toEqual({ hadToolCalls: false, teamDispatches: 0 });
      expect(summarizeRoundMessages([toolTurn('read_file')])).toEqual({ hadToolCalls: true, teamDispatches: 0 });
    });

    it('counts member hand-offs: one per delegate call, one per batch task', () => {
      expect(summarizeRoundMessages([
        toolTurn('delegate_to_agent'),
        toolTurn('run_agent_batch', { tasks: [{}, {}, {}] }),
      ])).toEqual({ hadToolCalls: true, teamDispatches: 4 });
    });
  });

  describe('handleDispatchSettled', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.clearAllMocks();
      resetGoalActivationsForTest();
      resetGoalDriverForTest();
      seed();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function createArmed(maxRounds = 5): GoalState {
      const result = createConversationGoal('c1', { objective: 'extract every contract', maxRounds });
      if (!result.ok) throw new Error(result.error);
      return result.goal;
    }

    it('starts the next round as a hidden goal-round run on a fresh loop', async () => {
      createArmed();
      handleDispatchSettled('c1', { reason: 'completed' });
      expect(runAgentLoopDispatched).not.toHaveBeenCalled(); // deferred to the next macrotask
      await vi.advanceTimersByTimeAsync(0);
      expect(runAgentLoopDispatched).toHaveBeenCalledTimes(1);
      const [convId, text, options] = runAgentLoopDispatched.mock.calls[0] as [string, string, Record<string, unknown>];
      expect(convId).toBe('c1');
      expect(text).toContain('<goal_round round="1" max="5">');
      expect(options).toMatchObject({ requireNewRun: true, initiatedBy: 'user', goalRound: { round: 1 } });
      expect(getGoal('c1')?.roundsStarted).toBe(1);
    });

    it('does not start a round while the conversation is busy or a user message is queued', async () => {
      createArmed();
      runningInSidecar.mockReturnValueOnce(true);
      handleDispatchSettled('c1', { reason: 'completed' });
      await vi.advanceTimersByTimeAsync(0);
      queuedInputs.mockReturnValueOnce([{ id: 'q', text: 'wait, one more thing' }]);
      handleDispatchSettled('c1', { reason: 'completed' });
      await vi.advanceTimersByTimeAsync(0);
      expect(runAgentLoopDispatched).not.toHaveBeenCalled();
      expect(getGoal('c1')?.roundsStarted).toBe(0);
    });

    it('never runs a disarmed goal (restored after a restart)', async () => {
      const created = createArmed();
      disarmGoal('c1', created.id, 'restart');
      handleDispatchSettled('c1', { reason: 'completed' });
      await vi.advanceTimersByTimeAsync(0);
      expect(runAgentLoopDispatched).not.toHaveBeenCalled();
    });

    it('disarms on a run error but keeps the goal active', async () => {
      const created = createArmed();
      handleDispatchSettled('c1', { reason: 'error', error: 'quota', messageTaken: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(runAgentLoopDispatched).not.toHaveBeenCalled();
      expect(getGoal('c1')?.phase).toBe('active');
      expect(getGoalActivation('c1', created.id)).toMatchObject({ armed: false, disarmReason: 'run-error' });
    });

    it('pauses when the user stops the run', () => {
      createArmed();
      handleDispatchSettled('c1', { reason: 'aborted' });
      expect(getGoal('c1')?.phase).toBe('paused');
      expect(notifyGoalBlocked).not.toHaveBeenCalled();
    });

    it('records each round and blocks after two idle rounds in a row', async () => {
      createArmed();
      handleDispatchSettled('c1', { reason: 'completed' }); // the creating run settles → round 1
      await vi.advanceTimersByTimeAsync(0);
      appendMessages([textTurn]);
      handleDispatchSettled('c1', { reason: 'completed' }); // round 1 idle → round 2
      await vi.advanceTimersByTimeAsync(0);
      expect(getGoal('c1')?.consecutiveIdleRounds).toBe(1);
      appendMessages([textTurn]);
      handleDispatchSettled('c1', { reason: 'completed' }); // round 2 idle → blocked
      await vi.advanceTimersByTimeAsync(0);
      expect(runAgentLoopDispatched).toHaveBeenCalledTimes(2);
      expect(getGoal('c1')).toMatchObject({ phase: 'blocked', blockedReason: { code: 'no-progress' } });
      expect(isGoalArmed('c1', getGoal('c1')?.id)).toBe(false);
      // The held-back round notices are replaced by one "goal stopped" notice.
      expect(notifyGoalBlocked).toHaveBeenCalledTimes(1);
      expect(notifyGoalBlocked).toHaveBeenCalledWith(expect.stringContaining('extract every contract'), 'c1');
    });

    it('treats the loop\'s no-progress guard as an idle round even when tools were called', async () => {
      createArmed();
      handleDispatchSettled('c1', { reason: 'completed' });
      await vi.advanceTimersByTimeAsync(0);
      appendMessages([toolTurn('read_file')]);
      handleDispatchSettled('c1', { reason: 'no_progress' });
      expect(getGoal('c1')?.consecutiveIdleRounds).toBe(1);
    });

    it('blocks when the round budget is spent', async () => {
      createArmed(1);
      handleDispatchSettled('c1', { reason: 'completed' });
      await vi.advanceTimersByTimeAsync(0);
      appendMessages([toolTurn('write_file')]);
      handleDispatchSettled('c1', { reason: 'completed' });
      expect(getGoal('c1')).toMatchObject({ phase: 'blocked', blockedReason: { code: 'round-limit' } });
    });

    it('accumulates team hand-offs across rounds and stops at the goal-wide cap', async () => {
      seed({ teamId: 'team-1' });
      createArmed(50);
      handleDispatchSettled('c1', { reason: 'completed' });
      await vi.advanceTimersByTimeAsync(0);
      const bigBatch = toolTurn('run_agent_batch', { tasks: Array.from({ length: GOAL_TEAM_MAX_DISPATCHES }, () => ({})) });
      appendMessages([bigBatch]);
      handleDispatchSettled('c1', { reason: 'completed' });
      expect(getGoal('c1')).toMatchObject({ phase: 'blocked', blockedReason: { code: 'team-dispatch-limit' } });
    });

    it('stops quietly once the model completed the goal', async () => {
      createArmed();
      const current = getGoal('c1')!;
      useChatStore.getState().setConversationGoal('c1', { ...current, phase: 'complete', revision: current.revision + 1 });
      handleDispatchSettled('c1', { reason: 'completed' });
      await vi.advanceTimersByTimeAsync(0);
      expect(runAgentLoopDispatched).not.toHaveBeenCalled();
    });

    it('disarms when the round dispatch itself throws', async () => {
      const created = createArmed();
      runAgentLoopDispatched.mockRejectedValueOnce(new Error('sidecar down'));
      kickGoalDriver('c1');
      await vi.advanceTimersByTimeAsync(0);
      expect(getGoalActivation('c1', created.id)).toMatchObject({ armed: false, disarmReason: 'run-error' });
      expect(getGoal('c1')?.phase).toBe('active');
    });
  });

  describe('installGoalDriver', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      resetGoalDriverForTest();
    });

    it('registers on the dispatch-settled seam exactly once', () => {
      installGoalDriver();
      installGoalDriver();
      expect(onDispatchSettled).toHaveBeenCalledTimes(1);
      expect(onDispatchSettled).toHaveBeenCalledWith(handleDispatchSettled);
    });
  });
});
