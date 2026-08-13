/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import type { Conversation, Message } from '@/types';
import MessageGroup from './MessageGroup';

describe('MessageGroup stopped terminal', () => {
  beforeEach(() => {
    initLanguage('en-US');
  });

  afterEach(() => {
    cleanup();
  });

  it('renders a persisted stopped status when the first-token placeholder was deleted', () => {
    const userMessage: Message = {
      id: 'user-stopped',
      role: 'user',
      content: 'inspect my desktop',
      timestamp: 1_000,
      loopId: 'loop-stopped',
      runState: 'interrupted',
      runEndedAt: 3_000,
    };
    const conversation: Conversation = {
      id: 'conversation-stopped',
      title: 'Stopped task',
      messages: [userMessage],
      createdAt: 1_000,
      updatedAt: 3_000,
      status: 'idle',
    };
    useChatStore.setState({
      activeConversationId: conversation.id,
      conversations: { [conversation.id]: conversation },
      agentStatus: 'idle',
    });

    render(<MessageGroup messages={[userMessage]} isLastGroup />);

    expect(screen.getByText('You stopped after 2s')).toBeInTheDocument();
  });
});
