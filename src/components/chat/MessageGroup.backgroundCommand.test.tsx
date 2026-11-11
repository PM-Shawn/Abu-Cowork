// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render as renderBare, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { getI18n, initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useWorkProcessFoldStore } from '@/stores/workProcessFoldStore';
import { TOOL_NAMES } from '@/core/tools/toolNames';
import type { Conversation, Message, ToolCall } from '@/types';
import MessageGroup from './MessageGroup';

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

const CONVERSATION_ID = 'conversation-background-command';

const stopCall: ToolCall = {
  id: 'tc-stop',
  name: TOOL_NAMES.STOP_BACKGROUND_COMMAND,
  input: { id: 'bg-0a1b2c3d' },
  result: 'Stop requested for background command bg-0a1b2c3d (npm run dev).',
  backgroundCommand: { command: 'npm run dev' },
};

/** A finished turn as it is loaded from disk after a restart: the step comes from the saved snapshot. */
function savedTurn(toolCalls: ToolCall[]): Message[] {
  return [
    { id: 'user', role: 'user', content: 'stop the server', timestamp: 1_000, loopId: 'loop', runState: 'completed', runEndedAt: 3_000 },
    {
      id: 'work',
      role: 'assistant',
      content: '',
      timestamp: 2_000,
      loopId: 'loop',
      toolCalls,
      executionSteps: [{
        id: 'step-stop',
        toolCallId: 'tc-stop',
        type: 'tool',
        label: 'Stop background command bg-0a1b2c3d',
        status: 'completed',
        toolName: TOOL_NAMES.STOP_BACKGROUND_COMMAND,
      }],
    },
    { id: 'answer', role: 'assistant', content: 'Stopped.', timestamp: 2_500, loopId: 'loop' },
  ];
}

function setConversation(messages: Message[]) {
  const conversation: Conversation = {
    id: CONVERSATION_ID, title: 'Server', messages, createdAt: 1_000, updatedAt: 3_000, status: 'idle',
  };
  useChatStore.setState({
    activeConversationId: conversation.id,
    conversations: { [conversation.id]: conversation },
    agentStates: new Map(),
  });
}

function openSteps() {
  fireEvent.click(screen.getByRole('button', { name: /Worked for/ }));
  fireEvent.click(screen.getByRole('button', { name: getI18n().task.calledTool }));
}

describe('MessageGroup background command of a saved step', () => {
  beforeEach(() => {
    initLanguage('en-US');
  });

  afterEach(() => {
    useWorkProcessFoldStore.getState().reset();
    cleanup();
  });

  it('shows the plain sentence for a saved step', () => {
    const messages = savedTurn([stopCall]);
    setConversation(messages);

    render(<MessageGroup conversationId={CONVERSATION_ID} messages={messages} isLastGroup />);
    openSteps();

    expect(screen.getByText('Stop a background task')).toBeInTheDocument();
  });

  it('keeps the saved label when the tool call recorded no command', () => {
    const { backgroundCommand: _backgroundCommand, ...plainCall } = stopCall;
    const messages = savedTurn([plainCall]);
    setConversation(messages);

    render(<MessageGroup conversationId={CONVERSATION_ID} messages={messages} isLastGroup />);
    openSteps();

    expect(screen.getByText('Stop background command bg-0a1b2c3d')).toBeInTheDocument();
  });
});
