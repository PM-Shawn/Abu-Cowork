// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import { createMaxTurnsNoticeMessage } from '@/core/agent/maxTurnsNotice';
import MaxTurnsNoticeCard from './MaxTurnsNoticeCard';

const mockRunAgentLoop = vi.fn();
const mockSetAction = vi.fn();
const mockCancelStreaming = vi.fn();
const mockAddToast = vi.fn();
const mockOpenSystemSettings = vi.fn();
const mockIsConversationRunningInSidecar = vi.fn();

const chatState = {
  conversations: {
    'conv-1': { id: 'conv-1', status: 'idle' },
  } as Record<string, { id: string; status: string }>,
  setMaxTurnsNoticeAction: mockSetAction,
  cancelStreaming: mockCancelStreaming,
};

vi.mock('@/core/agent/agentLoopRunner', () => ({
  runAgentLoopDispatched: (...args: unknown[]) => mockRunAgentLoop(...args),
}));

vi.mock('@/core/agent/sidecarRunPredicate', () => ({
  isConversationRunningInSidecar: (...args: unknown[]) =>
    mockIsConversationRunningInSidecar(...args),
}));

vi.mock('@/stores/chatStore', () => {
  const useChatStore = ((selector: (state: typeof chatState) => unknown) =>
    selector(chatState)) as {
    (selector: (state: typeof chatState) => unknown): unknown;
    getState: () => typeof chatState;
  };
  useChatStore.getState = () => chatState;
  return { useChatStore };
});

vi.mock('@/stores/toastStore', () => ({
  useToastStore: (selector: (state: { addToast: typeof mockAddToast }) => unknown) =>
    selector({ addToast: mockAddToast }),
}));

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (
    state: { openSystemSettings: typeof mockOpenSystemSettings },
  ) => unknown) => selector({ openSystemSettings: mockOpenSystemSettings }),
}));

function renderCard(options: { streak?: number; continued?: boolean } = {}) {
  const message = createMaxTurnsNoticeMessage({
    id: 'n1',
    timestamp: 1_000,
    limit: 200,
    streak: options.streak ?? 1,
  });
  if (options.continued) message.maxTurnsNotice!.action = 'continued';
  return render(<MaxTurnsNoticeCard conversationId="conv-1" message={message} />);
}

describe('MaxTurnsNoticeCard', () => {
  beforeEach(() => {
    initLanguage('en-US');
    vi.clearAllMocks();
    chatState.conversations['conv-1'].status = 'idle';
    mockIsConversationRunningInSidecar.mockReturnValue(false);
    mockSetAction.mockResolvedValue(undefined);
    mockRunAgentLoop.mockResolvedValue({ reason: 'completed' });
  });

  afterEach(() => {
    cleanup();
  });

  it('names the cap that was hit and offers both actions', () => {
    renderCard();

    expect(screen.getByRole('heading', { name: /200 turns/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Change the cap/i })).toBeInTheDocument();
  });

  it('reports the cap the RUN used, not whatever the setting says now', () => {
    const message = createMaxTurnsNoticeMessage({
      id: 'n1', timestamp: 1_000, limit: 40, streak: 1,
    });
    render(<MaxTurnsNoticeCard conversationId="conv-1" message={message} />);

    expect(screen.getByRole('heading', { name: /40 turns/i })).toBeInTheDocument();
  });

  it('continues the run and settles BEFORE dispatching, so the next notice counts as a repeat', async () => {
    const order: string[] = [];
    mockSetAction.mockImplementation(async () => { order.push('settle'); });
    mockRunAgentLoop.mockImplementation(async () => { order.push('dispatch'); return { reason: 'completed' }; });
    renderCard();

    await userEvent.click(screen.getByRole('button', { name: /Continue/i }));

    await waitFor(() => expect(mockRunAgentLoop).toHaveBeenCalled());
    expect(order).toEqual(['settle', 'dispatch']);
    expect(mockSetAction).toHaveBeenCalledWith('conv-1', 'max-turns-n1', 'continued');
    expect(mockRunAgentLoop).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('Continue the unfinished task'),
      expect.objectContaining({ requireNewRun: true, initiatedBy: 'user' }),
    );
  });

  it('stops a run that is somehow still in flight before continuing', async () => {
    chatState.conversations['conv-1'].status = 'running';
    mockCancelStreaming.mockImplementation(() => {
      chatState.conversations['conv-1'].status = 'idle';
    });
    renderCard();

    await userEvent.click(screen.getByRole('button', { name: /Continue/i }));

    await waitFor(() => expect(mockRunAgentLoop).toHaveBeenCalled());
    expect(mockCancelStreaming).toHaveBeenCalledWith('conv-1');
  });

  it('opens the general settings tab where the cap lives', async () => {
    renderCard();

    await userEvent.click(screen.getByRole('button', { name: /Change the cap/i }));

    expect(mockOpenSystemSettings).toHaveBeenCalledWith('general');
    expect(mockRunAgentLoop).not.toHaveBeenCalled();
  });

  it('warns about circling and leads with the cap from the second hit onwards', () => {
    renderCard({ streak: 2 });

    expect(screen.getByRole('heading', { name: /Hit 200 turns again/i })).toBeInTheDocument();
    expect(screen.getByText(/going in circles/i)).toBeInTheDocument();

    // Both actions stay available — the repeat only changes which one leads.
    const buttons = screen.getAllByRole('button');
    expect(buttons[0]).toHaveTextContent(/Change the cap/i);
    expect(buttons[1]).toHaveTextContent(/Continue/i);
  });

  it('still offers to continue on a long streak — no click budget', () => {
    renderCard({ streak: 7 });

    expect(screen.getByRole('button', { name: /Continue/i })).toBeEnabled();
  });

  it('collapses to a settled row once continued, with nothing left to click', () => {
    renderCard({ continued: true });

    expect(screen.getByText(/Continued/i)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('tells the user to carry on by hand when continuing fails', async () => {
    mockRunAgentLoop.mockRejectedValue(new Error('dispatch failed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderCard();

    await userEvent.click(screen.getByRole('button', { name: /Continue/i }));

    await waitFor(() => expect(mockAddToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' }),
    ));
    warn.mockRestore();
  });
});
