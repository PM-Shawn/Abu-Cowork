// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { getI18n, initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { useToastStore } from '@/stores/toastStore';
import { useWorkProcessFoldStore } from '@/stores/workProcessFoldStore';
import { runAgentLoopDispatched } from '@/core/agent/agentLoopRunner';
import type { Conversation, Message } from '@/types';
import MessageGroup from './MessageGroup';

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
