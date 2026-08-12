/// <reference types="@testing-library/jest-dom" />
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import type { SandboxRecoveryAction } from '@/types';
import SandboxRecoveryCard from './SandboxRecoveryCard';

const mockRunAgentLoop = vi.fn();
const mockSetAction = vi.fn();
const mockCancelStreaming = vi.fn();
const mockAddToast = vi.fn();
const mockOpenSystemSettings = vi.fn();
const mockIsConversationRunningInSidecar = vi.fn();

const chatState = {
  conversations: {
    'conv-1': {
      id: 'conv-1',
      status: 'idle',
    },
  } as Record<string, { id: string; status: string }>,
  setToolCallSandboxRecoveryAction: mockSetAction,
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
  useSettingsStore: {
    getState: () => ({ openSystemSettings: mockOpenSystemSettings }),
  },
}));

function renderCard(settledAction?: SandboxRecoveryAction) {
  return render(
    <SandboxRecoveryCard
      conversationId="conv-1"
      messageId="msg-1"
      toolCallId="tc-1"
      recovery={{ kind: 'app-automation', targetApp: 'Notes' }}
      settledAction={settledAction}
    />,
  );
}

describe('SandboxRecoveryCard', () => {
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

  it('explains the blocked target and offers explicit recovery choices', () => {
    renderCard();

    expect(screen.getByRole('heading', { name: /Shell sandbox blocked cross-app control/i })).toBeInTheDocument();
    expect(screen.getByText(/Notes/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue with Computer Use/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Keep sandbox and stop/i })).toBeInTheDocument();
  });

  it('continues the same conversation with a Computer Use-only instruction', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole('button', { name: /Continue with Computer Use/i }));

    await waitFor(() => {
      expect(mockRunAgentLoop).toHaveBeenCalledWith(
        'conv-1',
        expect.stringMatching(/Computer Use.*Notes/i),
        {
          allowedTools: ['computer', 'ask_user_question'],
          requireNewRun: true,
        },
      );
    });
    expect(mockSetAction.mock.calls.map((call) => call[3])).toEqual([
      'pending',
      'started',
      'completed',
    ]);
  });

  it('cancels an active task before settling the stop choice', async () => {
    const user = userEvent.setup();
    chatState.conversations['conv-1'].status = 'running';
    mockCancelStreaming.mockImplementationOnce(() => {
      chatState.conversations['conv-1'].status = 'idle';
    });
    renderCard();

    await user.click(screen.getByRole('button', { name: /Keep sandbox and stop/i }));

    expect(mockCancelStreaming).toHaveBeenCalledWith('conv-1');
    expect(mockSetAction).toHaveBeenCalledWith('conv-1', 'msg-1', 'tc-1', 'stopped');
  });

  it('waits for a sidecar run to stop before persisting the stop choice', async () => {
    const user = userEvent.setup();
    mockIsConversationRunningInSidecar
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    renderCard();

    await user.click(screen.getByRole('button', { name: /Keep sandbox and stop/i }));

    expect(mockCancelStreaming).toHaveBeenCalledWith('conv-1');
    expect(mockIsConversationRunningInSidecar).toHaveBeenCalledTimes(2);
    expect(mockSetAction).toHaveBeenCalledWith('conv-1', 'msg-1', 'tc-1', 'stopped');
  });

  it('keeps sandbox changes behind an advanced warning and only opens settings', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole('button', { name: /Advanced/i }));
    expect(screen.getByText(/Abu will not turn it off automatically/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Open security settings/i }));
    expect(mockOpenSystemSettings).toHaveBeenCalledWith('sandbox');
  });

  it('renders a non-interactive settled state after Computer Use completes', () => {
    renderCard('completed');

    expect(screen.getByText(/Computer Use completed this task/i)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('persists an aborted recovery as stopped instead of completed', async () => {
    const user = userEvent.setup();
    mockRunAgentLoop.mockResolvedValueOnce({ reason: 'aborted' });
    renderCard();

    await user.click(screen.getByRole('button', { name: /Continue with Computer Use/i }));

    await waitFor(() => {
      expect(mockSetAction.mock.calls.map((call) => call[3])).toEqual([
        'pending',
        'started',
        'stopped',
      ]);
    });
  });

  it('requires review when a started recovery ends with an error', async () => {
    const user = userEvent.setup();
    mockRunAgentLoop.mockResolvedValueOnce({ reason: 'error', error: 'startup failed' });
    renderCard();

    await user.click(screen.getByRole('button', { name: /Continue with Computer Use/i }));

    await waitFor(() => {
      expect(mockSetAction).toHaveBeenLastCalledWith(
        'conv-1',
        'msg-1',
        'tc-1',
        'needs-review',
      );
    });
    expect(screen.getByText(/may have completed part of the operation/i)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(mockAddToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }));
  });

  it('renders interrupted persisted work as retryable', () => {
    renderCard('failed');

    expect(screen.getByText(/Safe recovery could not start/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue with Computer Use/i })).toBeInTheDocument();
  });

  it('does not report completion when persistence fails', async () => {
    const user = userEvent.setup();
    mockSetAction.mockRejectedValueOnce(new Error('disk unavailable'));
    renderCard();

    await user.click(screen.getByRole('button', { name: /Continue with Computer Use/i }));

    await waitFor(() => {
      expect(mockRunAgentLoop).not.toHaveBeenCalled();
      expect(mockAddToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    });
  });

  it('does not offer a retry when completion persistence is uncertain', async () => {
    const user = userEvent.setup();
    mockSetAction.mockImplementation(
      async (_convId, _messageId, _toolCallId, action: SandboxRecoveryAction) => {
        if (action === 'completed') throw new Error('disk unavailable');
      },
    );
    renderCard();

    await user.click(screen.getByRole('button', { name: /Continue with Computer Use/i }));

    await waitFor(() => {
      expect(screen.getByText(/may have completed part of the operation/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(mockSetAction.mock.calls.map((call) => call[3])).toEqual([
      'pending',
      'started',
      'completed',
      'needs-review',
    ]);
  });
});
