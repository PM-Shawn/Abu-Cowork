// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const kickGoalDriver = vi.fn();
vi.mock('@/core/goal/goalDriver', () => ({ kickGoalDriver: (id: string) => kickGoalDriver(id) }));

import { getLanguageSetting, initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import type { Conversation, Message } from '@/types';
import { disarmGoal, isGoalArmed, resetGoalActivationsForTest } from '@/core/goal/goalActivation';
import { createConversationGoal, getGoal } from '@/core/goal/goalService';
import type { GoalState } from '@/core/goal/goalTypes';
import GoalBar from './GoalBar';
import GoalRoundMarker from './GoalRoundMarker';

function seed(over: Partial<Conversation> = {}): void {
  useChatStore.setState({
    conversations: { c1: { id: 'c1', title: 't', createdAt: 1, updatedAt: 1, status: 'completed', messages: [], ...over } },
    conversationIndex: { c1: { id: 'c1', title: 't', createdAt: 1, updatedAt: 1, messageCount: 0 } },
  } as never);
}

function createGoal(objective = 'Extract every contract into summary.xlsx'): GoalState {
  const result = createConversationGoal('c1', { objective, maxRounds: 10 });
  if (!result.ok) throw new Error(result.error);
  return result.goal;
}

function setGoal(patch: Partial<GoalState>): void {
  const goal = getGoal('c1')!;
  act(() => useChatStore.getState().setConversationGoal('c1', { ...goal, revision: goal.revision + 1, ...patch }));
}

describe('GoalBar', () => {
  let previousLanguage: ReturnType<typeof getLanguageSetting>;

  beforeEach(() => {
    previousLanguage = getLanguageSetting();
    initLanguage('en-US');
    vi.clearAllMocks();
    resetGoalActivationsForTest();
    seed();
  });

  afterEach(() => {
    cleanup();
    initLanguage(previousLanguage);
  });

  describe('render', () => {
    it('renders nothing without a goal', () => {
      const { container } = render(<GoalBar conversationId="c1" />);
      expect(container).toBeEmptyDOMElement();
    });

    it('shows the objective, round usage and a pause control while armed', () => {
      createGoal();
      render(<GoalBar conversationId="c1" />);
      expect(screen.getByText('Extract every contract into summary.xlsx')).toBeInTheDocument();
      expect(screen.getByText('Round 0 of 10')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Pause/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Resume/ })).not.toBeInTheDocument();
    });

    it('says why automatic rounds stopped and offers resume', () => {
      const goal = createGoal();
      act(() => disarmGoal('c1', goal.id, 'run-error'));
      render(<GoalBar conversationId="c1" />);
      expect(screen.getByText(/A run failed; automatic rounds stopped/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Resume/ })).toBeInTheDocument();
    });

    it('offers more rounds once the budget is spent', () => {
      createGoal();
      setGoal({ phase: 'blocked', roundsStarted: 10, blockedReason: { code: 'round-limit', message: '' } });
      render(<GoalBar conversationId="c1" />);
      expect(screen.getByText('All rounds used')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Run 20 more/ })).toBeInTheDocument();
    });

    it('shows the completion summary with expandable evidence', async () => {
      createGoal();
      setGoal({ phase: 'complete', completion: { summary: 'All 300 contracts extracted', evidence: ['summary.xlsx has 300 rows'] } });
      render(<GoalBar conversationId="c1" />);
      expect(screen.getByText('Goal complete')).toBeInTheDocument();
      expect(screen.getByText('All 300 contracts extracted')).toBeInTheDocument();
      expect(screen.queryByText('summary.xlsx has 300 rows')).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: /Evidence/ }));
      expect(screen.getByText('summary.xlsx has 300 rows')).toBeInTheDocument();
    });
  });

  describe('actions', () => {
    it('pause disarms; resume re-arms and kicks the driver', async () => {
      const goal = createGoal();
      render(<GoalBar conversationId="c1" />);
      await userEvent.click(screen.getByRole('button', { name: /Pause/ }));
      expect(getGoal('c1')?.phase).toBe('paused');
      expect(isGoalArmed('c1', goal.id)).toBe(false);
      await userEvent.click(screen.getByRole('button', { name: /Resume/ }));
      expect(getGoal('c1')?.phase).toBe('active');
      expect(isGoalArmed('c1', goal.id)).toBe(true);
      expect(kickGoalDriver).toHaveBeenCalledWith('c1');
    });

    it('edits the objective inline', async () => {
      createGoal();
      render(<GoalBar conversationId="c1" />);
      await userEvent.click(screen.getByRole('button', { name: 'Edit goal' }));
      const input = screen.getByRole('textbox');
      await userEvent.clear(input);
      await userEvent.type(input, 'Only the 2025 contracts{Enter}');
      expect(getGoal('c1')?.objective).toBe('Only the 2025 contracts');
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });

    it('asks before clearing', async () => {
      createGoal();
      render(<GoalBar conversationId="c1" />);
      await userEvent.click(screen.getByRole('button', { name: 'Clear goal' }));
      expect(getGoal('c1')).toBeDefined();
      expect(screen.getByText('Clear this goal?')).toBeInTheDocument();
      const confirmButtons = screen.getAllByRole('button', { name: 'Clear goal' });
      await userEvent.click(confirmButtons[confirmButtons.length - 1]);
      expect(getGoal('c1')).toBeUndefined();
    });
  });
});

describe('GoalRoundMarker', () => {
  afterEach(() => cleanup());

  it('labels the round, and renders nothing for an ordinary message', () => {
    const round: Message = {
      id: 'm', role: 'user', content: '<goal_round/>', timestamp: 1, isSystem: true,
      goalRound: { goalId: 'g1', revision: 2, round: 3 },
    };
    render(<GoalRoundMarker message={round} maxRounds={10} />);
    expect(screen.getByText('Goal round 3 of 10')).toBeInTheDocument();
    cleanup();
    const { container } = render(<GoalRoundMarker message={{ ...round, goalRound: undefined }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says when the round was stopped or failed, since it replaces the bubble that would', () => {
    const round: Message = {
      id: 'm', role: 'user', content: '<goal_round/>', timestamp: 1, isSystem: true,
      goalRound: { goalId: 'g1', revision: 2, round: 1 },
    };
    render(<GoalRoundMarker message={{ ...round, runState: 'completed' }} maxRounds={10} />);
    expect(screen.queryByTestId('goal-round-outcome')).not.toBeInTheDocument();
    cleanup();
    render(<GoalRoundMarker message={{ ...round, runState: 'interrupted' }} maxRounds={10} />);
    expect(screen.getByTestId('goal-round-outcome')).toHaveTextContent('stopped');
    cleanup();
    render(<GoalRoundMarker message={{ ...round, runState: 'connection-failed' }} maxRounds={10} />);
    expect(screen.getByTestId('goal-round-outcome')).toHaveTextContent('failed');
  });
});
