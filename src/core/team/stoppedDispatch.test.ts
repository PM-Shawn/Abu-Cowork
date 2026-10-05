import { describe, it, expect, beforeEach } from 'vitest';
import { useTeamConfirmationStore } from '@/stores/teamConfirmationStore';
import { clearRunBounds, recordDispatchOutcome } from './teamRunBounds';
import { surfaceStoppedDispatch } from './stoppedDispatch';

const stops = () => Object.values(useTeamConfirmationStore.getState().stopped);

describe('surfaceStoppedDispatch', () => {
  beforeEach(() => {
    useTeamConfirmationStore.setState({ pending: {}, approvedOnce: {}, taskRules: {}, retrySelections: {}, currentTaskByConversation: {}, stopped: {} });
    clearRunBounds('task-1');
  });

  it('shows a blocked member with its failure count and last failure', () => {
    recordDispatchOutcome('task-1', 'A', false, 'missing out.md');
    surfaceStoppedDispatch({ conversationId: 'c1', teamTaskId: 'task-1' }, { ok: false, reason: 'member_blocked', member: 'A', failures: 3 });
    expect(stops()).toEqual([expect.objectContaining({
      conversationId: 'c1', taskId: 'task-1', reason: 'member_blocked', member: 'A', count: 3, lastFailure: 'missing out.md',
    })]);
  });

  it('shows a task that used its hand-off allowance', () => {
    surfaceStoppedDispatch({ conversationId: 'c1', teamTaskId: 'task-1' }, { ok: false, reason: 'run_cap', max: 40, used: 40 });
    expect(stops()).toEqual([expect.objectContaining({ reason: 'run_cap', count: 40 })]);
    expect(stops()[0].member).toBeUndefined();
  });

  it('shows nothing outside a team task', () => {
    surfaceStoppedDispatch({ conversationId: 'c1' }, { ok: false, reason: 'run_cap', max: 40, used: 40 });
    surfaceStoppedDispatch(undefined, { ok: false, reason: 'run_cap', max: 40, used: 40 });
    expect(stops()).toEqual([]);
  });
});
