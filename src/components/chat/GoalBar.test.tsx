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
import { disarmGoal, isGoalArmed, resetGoalActivationsForTest, setGoalRetry } from '@/core/goal/goalActivation';
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

    it('is one row while armed: status word, objective and icon controls, with no round count', () => {
      createGoal();
      setGoal({ roundsStarted: 3 });
      render(<GoalBar conversationId="c1" />);
      expect(screen.getByTestId('goal-bar')).toHaveTextContent(/^Ongoing goalExtract every contract into summary\.xlsx$/);
      expect(screen.getByRole('button', { name: 'Pause goal' })).toHaveTextContent('');
      expect(screen.queryByRole('button', { name: 'Resume goal' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Edit goal' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Clear goal' })).toBeInTheDocument();
    });

    it('counts the working time up while armed', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(1_000_000);
        createGoal();
        setGoal({ elapsedMs: 60_000 });
        render(<GoalBar conversationId="c1" />);
        act(() => { vi.advanceTimersByTime(5_000); });
        expect(screen.getByTestId('goal-bar-aside')).toHaveTextContent(/^1m 5s$/);
      } finally {
        vi.useRealTimers();
      }
    });

    it('shows a goal stopped by a restart or by the user as paused, and offers resume', () => {
      const goal = createGoal();
      act(() => disarmGoal('c1', goal.id, 'restart'));
      render(<GoalBar conversationId="c1" />);
      expect(screen.getByTestId('goal-bar-status')).toHaveTextContent('Paused goal');
      expect(screen.getByRole('button', { name: 'Resume goal' })).toBeInTheDocument();
      expect(screen.queryByTestId('goal-bar-aside')).not.toBeInTheDocument();
      act(() => disarmGoal('c1', goal.id, 'user-stop'));
      expect(screen.getByTestId('goal-bar-status')).toHaveTextContent('Paused goal');
    });

    it('keeps a failed run as the hover detail of a paused goal', () => {
      const goal = createGoal();
      act(() => disarmGoal('c1', goal.id, 'run-error'));
      render(<GoalBar conversationId="c1" />);
      expect(screen.getByTestId('goal-bar-status')).toHaveTextContent('Paused goal');
      expect(screen.getByText('Extract every contract into summary.xlsx')).toHaveAttribute('title', 'Paused after a run failed');
      expect(screen.getByRole('button', { name: 'Resume goal' })).toBeInTheDocument();
    });

    it('says when a failed run is retried', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(1_000_000);
        const goal = createGoal();
        act(() => setGoalRetry('c1', goal.id, { attempt: 2, at: 1_000_000 + 5 * 60_000 }));
        render(<GoalBar conversationId="c1" />);
        expect(screen.getByTestId('goal-bar-status')).toHaveTextContent('Ongoing goal');
        expect(screen.getByTestId('goal-bar-aside')).toHaveTextContent('A run failed, retrying in 5 min');
        expect(screen.getByRole('button', { name: 'Pause goal' })).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('offers a plain resume once the automatic work limit is reached', () => {
      createGoal();
      setGoal({ phase: 'blocked', roundsStarted: 10, blockedReason: { code: 'round-limit', message: '' } });
      render(<GoalBar conversationId="c1" />);
      expect(screen.getByTestId('goal-bar-status')).toHaveTextContent('Blocked goal');
      expect(screen.getByText('Extract every contract into summary.xlsx')).toHaveAttribute('title', 'Worked for a long time, stopped for now');
      expect(screen.getByRole('button', { name: 'Resume goal' })).toBeInTheDocument();
    });

    it('gives the model\'s own reason as the hover detail of a blocked goal', () => {
      createGoal();
      setGoal({ phase: 'blocked', blockedReason: { code: 'model-reported', message: 'Needs the VPN password' } });
      render(<GoalBar conversationId="c1" />);
      expect(screen.getByText('Extract every contract into summary.xlsx')).toHaveAttribute('title', 'Needs the VPN password');
    });

    it('goes away once the goal is complete', () => {
      createGoal();
      const { container } = render(<GoalBar conversationId="c1" />);
      expect(screen.getByTestId('goal-bar')).toBeInTheDocument();
      setGoal({ phase: 'complete', elapsedMs: 5 * 60_000, completion: { summary: 'All 300 contracts extracted', evidence: ['summary.xlsx has 300 rows'] } });
      expect(container).toBeEmptyDOMElement();
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

  it('marks where the app continued the goal, with the time and no round number, and renders nothing for an ordinary message', () => {
    const timestamp = new Date(2026, 9, 5, 14, 32).getTime();
    const round: Message = {
      id: 'm', role: 'user', content: '<goal_round/>', timestamp, isSystem: true,
      goalRound: { goalId: 'g1', revision: 2, round: 7 },
    };
    render(<GoalRoundMarker message={round} />);
    const marker = screen.getByTestId('goal-round-marker');
    expect(marker).toHaveTextContent('Continuing the goal');
    expect(marker).toHaveTextContent(/32/);
    expect(marker).not.toHaveTextContent(/7|round/i);
    cleanup();
    const { container } = render(<GoalRoundMarker message={{ ...round, goalRound: undefined }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says when the round was stopped or failed, since it replaces the bubble that would', () => {
    const round: Message = {
      id: 'm', role: 'user', content: '<goal_round/>', timestamp: 1, isSystem: true,
      goalRound: { goalId: 'g1', revision: 2, round: 1 },
    };
    render(<GoalRoundMarker message={{ ...round, runState: 'completed' }} />);
    expect(screen.queryByTestId('goal-round-outcome')).not.toBeInTheDocument();
    cleanup();
    render(<GoalRoundMarker message={{ ...round, runState: 'interrupted' }} />);
    expect(screen.getByTestId('goal-round-outcome')).toHaveTextContent('stopped');
    cleanup();
    render(<GoalRoundMarker message={{ ...round, runState: 'connection-failed' }} />);
    expect(screen.getByTestId('goal-round-outcome')).toHaveTextContent('failed');
  });
});
