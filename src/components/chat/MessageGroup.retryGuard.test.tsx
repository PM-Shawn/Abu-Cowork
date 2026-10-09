// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { act, cleanup, fireEvent, render as renderBare, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { getI18n, initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { useToastStore } from '@/stores/toastStore';
import { useWorkProcessFoldStore } from '@/stores/workProcessFoldStore';
import { runAgentLoopDispatched } from '@/core/agent/agentLoopRunner';
import type { Conversation, Message } from '@/types';
import MessageGroup from './MessageGroup';

// The action row's icon buttons carry ds tooltips, which need the provider the app mounts at its root.
const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

vi.mock('@/core/agent/agentLoopRunner', () => ({
  runAgentLoopDispatched: vi.fn(),
}));

vi.mock('@/core/session/outputSnapshots', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/core/session/outputSnapshots')>(),
  resolveFileSource: vi.fn().mockResolvedValue({ status: 'missing', basename: 'x', originalPath: '/tmp/x' }),
}));

describe('MessageGroup retry when the conversation pinned model is no longer usable', () => {
  let deleteSpy: MockInstance | undefined;

  beforeEach(() => {
    initLanguage('en-US');
    vi.mocked(runAgentLoopDispatched).mockReset();
    useSettingsStore.setState(useSettingsStore.getInitialState(), true);
    useSettingsStore.setState((state) => ({
      providers: state.providers.map((provider) =>
        provider.id === 'anthropic' ? { ...provider, enabled: true, apiKey: 'test-key' } : provider,
      ),
    }));
    useEnterpriseStore.setState({ mode: { kind: 'personal' }, initialized: true });
    useToastStore.setState(useToastStore.getInitialState(), true);
  });

  afterEach(() => {
    deleteSpy?.mockRestore();
    deleteSpy = undefined;
    useToastStore.setState(useToastStore.getInitialState(), true);
    useSettingsStore.setState(useSettingsStore.getInitialState(), true);
    useEnterpriseStore.setState(useEnterpriseStore.getInitialState(), true);
    useWorkProcessFoldStore.getState().reset();
    cleanup();
  });

  it('refuses the assistant-side retry before rewinding or dispatching', () => {
    const userMessage: Message = {
      id: 'user-1', role: 'user', content: 'do the thing', timestamp: 1_000, loopId: 'loop-1', runState: 'completed', runEndedAt: 3_000,
    };
    const assistantMessage: Message = {
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      timestamp: 2_000,
      loopId: 'loop-1',
      toolCalls: [{ id: 'call-1', name: 'read_file', input: { path: '/tmp/a' }, result: 'Error: boom' }],
      executionSteps: [{
        id: 'step-1', toolCallId: 'call-1', type: 'tool', label: 'Read file', status: 'error', toolName: 'read_file',
      }],
    };
    // A later turn means an unguarded retry would ask to rewind it first.
    const laterTurn: Message = { id: 'user-2', role: 'user', content: 'next', timestamp: 4_000, loopId: 'loop-2' };
    const conversation: Conversation = {
      id: 'conversation-1',
      title: 'Failed task',
      messages: [userMessage, assistantMessage, laterTurn],
      createdAt: 1_000,
      updatedAt: 3_000,
      status: 'idle',
      model: { providerId: 'gone-provider', modelId: 'model-a' },
    };
    useChatStore.setState({
      activeConversationId: conversation.id,
      conversations: { [conversation.id]: conversation },
      agentStates: new Map(),
    });
    deleteSpy = vi.spyOn(useChatStore.getState(), 'deleteMessagesFrom');
    const before = useChatStore.getState().conversations[conversation.id].messages;

    render(<MessageGroup conversationId={conversation.id} messages={[userMessage, assistantMessage]} isLastGroup />);
    // The failed step block starts collapsed; open it to reach its Retry control.
    fireEvent.click(screen.getByText('Called tool').closest('button')!);
    fireEvent.click(screen.getByRole('button', { name: getI18n().task.retryAction }));

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(useChatStore.getState().conversations[conversation.id].messages).toBe(before);
    expect(runAgentLoopDispatched).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ type: 'error', title: expect.stringContaining('model-a') }),
    ]);
    expect(screen.queryByText(getI18n().chat.rewindConfirmTitle)).not.toBeInTheDocument();
  });
});

describe('MessageGroup retry question', () => {
  const CONVERSATION = 'conversation-1';
  const userMessage: Message = {
    id: 'user-1', role: 'user', content: 'do the thing', timestamp: 1_000, loopId: 'loop-1', runState: 'completed', runEndedAt: 3_000,
  };
  const assistantMessage: Message = {
    id: 'assistant-1',
    role: 'assistant',
    content: '',
    timestamp: 2_000,
    loopId: 'loop-1',
    toolCalls: [{ id: 'call-1', name: 'read_file', input: { path: '/fake/project/a' }, result: 'Error: boom' }],
    executionSteps: [{
      id: 'step-1', toolCallId: 'call-1', type: 'tool', label: 'Read file', status: 'error', toolName: 'read_file',
    }],
  };
  const laterTurn: Message = { id: 'user-2', role: 'user', content: 'next', timestamp: 4_000, loopId: 'loop-2' };
  let deleteSpy: MockInstance;

  function seed(messages: Message[]) {
    const conversation: Conversation = {
      id: CONVERSATION,
      title: 'Failed task',
      messages,
      createdAt: 1_000,
      updatedAt: 3_000,
      status: 'idle',
      model: { providerId: 'anthropic', modelId: 'model-a' },
    };
    useChatStore.setState({
      activeConversationId: conversation.id,
      conversations: { [conversation.id]: conversation },
      agentStates: new Map(),
    });
    deleteSpy = vi.spyOn(useChatStore.getState(), 'deleteMessagesFrom');
  }
  const stored = () => useChatStore.getState().conversations[CONVERSATION].messages;
  const questionTitle = () => screen.queryByText(getI18n().chat.rewindConfirmTitle);
  const answered = () => act(async () => {});
  function pressRetry() {
    // The failed step block starts collapsed; open it to reach its Retry control.
    fireEvent.click(screen.getByText('Called tool').closest('button')!);
    fireEvent.click(screen.getByRole('button', { name: getI18n().task.retryAction }));
  }

  beforeEach(() => {
    initLanguage('en-US');
    vi.mocked(runAgentLoopDispatched).mockReset();
    vi.mocked(runAgentLoopDispatched).mockResolvedValue({ reason: 'completed' });
    useSettingsStore.setState(useSettingsStore.getInitialState(), true);
    useSettingsStore.setState((state) => ({
      providers: state.providers.map((provider) =>
        provider.id === 'anthropic'
          ? { ...provider, enabled: true, apiKey: 'test-key', models: [...provider.models, { ...provider.models[0], id: 'model-a', label: '' }] }
          : provider,
      ),
    }));
    useEnterpriseStore.setState({ mode: { kind: 'personal' }, initialized: true });
    useToastStore.setState(useToastStore.getInitialState(), true);
  });

  afterEach(() => {
    deleteSpy.mockRestore();
    useToastStore.setState(useToastStore.getInitialState(), true);
    useSettingsStore.setState(useSettingsStore.getInitialState(), true);
    useEnterpriseStore.setState(useEnterpriseStore.getInitialState(), true);
    useWorkProcessFoldStore.getState().reset();
    cleanup();
  });

  it('retries at once, with no question, when no turn follows', async () => {
    seed([userMessage, assistantMessage]);
    render(<MessageGroup conversationId={CONVERSATION} messages={[userMessage, assistantMessage]} isLastGroup />);

    pressRetry();
    await answered();

    expect(questionTitle()).not.toBeInTheDocument();
    expect(deleteSpy.mock.calls).toEqual([[CONVERSATION, assistantMessage.id]]);
    expect(runAgentLoopDispatched).toHaveBeenCalledTimes(1);
    expect(runAgentLoopDispatched).toHaveBeenCalledWith(CONVERSATION, 'do the thing', { initiatedBy: 'user' });
  });

  it('asks with the number of turns that follow, and Cancel deletes nothing', async () => {
    seed([userMessage, assistantMessage, laterTurn]);
    const before = stored();
    render(<MessageGroup conversationId={CONVERSATION} messages={[userMessage, assistantMessage]} isLastGroup />);

    pressRetry();
    expect(questionTitle()).toBeInTheDocument();
    expect(screen.getByText(getI18n().chat.rewindConfirmMessage.replace('{count}', '1'))).toBeInTheDocument();
    expect(deleteSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: getI18n().common.cancel }));
    await answered();
    expect(questionTitle()).not.toBeInTheDocument();
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(runAgentLoopDispatched).not.toHaveBeenCalled();
    expect(stored()).toBe(before);
  });

  it('deletes and sends once after Confirm', async () => {
    seed([userMessage, assistantMessage, laterTurn]);
    render(<MessageGroup conversationId={CONVERSATION} messages={[userMessage, assistantMessage]} isLastGroup />);

    pressRetry();
    fireEvent.click(screen.getByRole('button', { name: getI18n().common.confirm }));
    await answered();

    expect(questionTitle()).not.toBeInTheDocument();
    expect(deleteSpy.mock.calls).toEqual([[CONVERSATION, assistantMessage.id]]);
    expect(stored()).toEqual([userMessage]);
    expect(runAgentLoopDispatched).toHaveBeenCalledTimes(1);
    expect(runAgentLoopDispatched).toHaveBeenCalledWith(CONVERSATION, 'do the thing', { initiatedBy: 'user' });
  });

  it('asks in a question window that opens on Cancel', () => {
    seed([userMessage, assistantMessage, laterTurn]);
    render(<MessageGroup conversationId={CONVERSATION} messages={[userMessage, assistantMessage]} isLastGroup />);

    pressRetry();

    expect(screen.getByRole('alertdialog', { name: getI18n().chat.rewindConfirmTitle })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: getI18n().common.cancel })).toHaveFocus();
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
  });

  it('deletes nothing when the turn has left the conversation by the time of the answer', async () => {
    seed([userMessage, assistantMessage, laterTurn]);
    render(<MessageGroup conversationId={CONVERSATION} messages={[userMessage, assistantMessage]} isLastGroup />);

    pressRetry();
    act(() => {
      useChatStore.setState((state) => ({
        conversations: { [CONVERSATION]: { ...state.conversations[CONVERSATION], messages: [laterTurn] } },
      }));
    });
    const before = stored();
    fireEvent.click(screen.getByRole('button', { name: getI18n().common.confirm }));
    await answered();

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(runAgentLoopDispatched).not.toHaveBeenCalled();
    expect(stored()).toBe(before);
  });

  const setStatus = (status: Conversation['status']) => act(() => {
    useChatStore.setState((state) => ({
      conversations: { [CONVERSATION]: { ...state.conversations[CONVERSATION], status } },
    }));
  });

  it('deletes nothing when a run has started on the conversation by the time of the answer', async () => {
    seed([userMessage, assistantMessage, laterTurn]);
    render(<MessageGroup conversationId={CONVERSATION} messages={[userMessage, assistantMessage]} isLastGroup />);

    pressRetry();
    setStatus('running');
    const before = stored();
    fireEvent.click(screen.getByRole('button', { name: getI18n().common.confirm }));
    await answered();

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(runAgentLoopDispatched).not.toHaveBeenCalled();
    expect(stored()).toBe(before);
  });

  // The retry of a failed step is offered while another part of the conversation runs; a
  // question asked then is answered as before.
  it('still retries when the conversation was already running when the question was asked', async () => {
    seed([userMessage, assistantMessage, laterTurn]);
    setStatus('running');
    render(<MessageGroup conversationId={CONVERSATION} messages={[userMessage, assistantMessage]} isLastGroup />);

    pressRetry();
    fireEvent.click(screen.getByRole('button', { name: getI18n().common.confirm }));
    await answered();

    expect(deleteSpy.mock.calls).toEqual([[CONVERSATION, assistantMessage.id]]);
    expect(runAgentLoopDispatched).toHaveBeenCalledTimes(1);
  });

  it('deletes nothing when more turns follow at the answer than the question named', async () => {
    seed([userMessage, assistantMessage, laterTurn]);
    render(<MessageGroup conversationId={CONVERSATION} messages={[userMessage, assistantMessage]} isLastGroup />);

    pressRetry();
    const another: Message = { id: 'user-3', role: 'user', content: 'and more', timestamp: 5_000, loopId: 'loop-3' };
    act(() => {
      useChatStore.setState((state) => ({
        conversations: { [CONVERSATION]: { ...state.conversations[CONVERSATION], messages: [userMessage, assistantMessage, laterTurn, another] } },
      }));
    });
    const before = stored();
    fireEvent.click(screen.getByRole('button', { name: getI18n().common.confirm }));
    await answered();

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(runAgentLoopDispatched).not.toHaveBeenCalled();
    expect(stored()).toBe(before);
  });
});
