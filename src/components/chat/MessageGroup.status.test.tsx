// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useBatchProgressStore } from '@/stores/batchProgressStore';
import { TOOL_NAMES } from '@/core/tools/toolNames';
import type { Conversation, Message } from '@/types';
import MessageGroup from './MessageGroup';

describe('MessageGroup stopped terminal', () => {
  beforeEach(() => {
    initLanguage('en-US');
  });

  afterEach(() => {
    for (const batchId of Object.keys(useBatchProgressStore.getState().batches)) {
      useBatchProgressStore.getState().clearBatch(batchId);
    }
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

  it('keeps a terminal batch card visible while its ephemeral progress entry exists', () => {
    const userMessage: Message = {
      id: 'user-batch',
      role: 'user',
      content: 'run a batch',
      timestamp: 1_000,
      loopId: 'loop-batch',
      runState: 'completed',
      runEndedAt: 3_000,
    };
    const assistantMessage: Message = {
      id: 'assistant-batch',
      role: 'assistant',
      content: '',
      timestamp: 2_000,
      loopId: 'loop-batch',
      toolCalls: [{
        id: 'batch-tool-call',
        name: TOOL_NAMES.RUN_AGENT_BATCH,
        input: { tasks: [{ task: 'inspect' }] },
        result: '1 sub-tasks total: 1 succeeded, 0 failed',
      }],
    };
    const conversation: Conversation = {
      id: 'conversation-batch',
      title: 'Batch task',
      messages: [userMessage, assistantMessage],
      createdAt: 1_000,
      updatedAt: 3_000,
      status: 'idle',
    };
    useChatStore.setState({
      activeConversationId: conversation.id,
      conversations: { [conversation.id]: conversation },
      agentStatus: 'idle',
    });
    const store = useBatchProgressStore.getState();
    store.initBatch('batch-tool-call', ['inspect']);
    store.setTaskDone('batch-tool-call', 0);

    const view = render(<MessageGroup messages={conversation.messages} isLastGroup />);

    expect(screen.getByText('✓ 1 sub-tasks completed')).toBeInTheDocument();
    store.clearBatch('batch-tool-call');
    view.rerender(<MessageGroup messages={conversation.messages} isLastGroup />);
    expect(screen.queryByText('✓ 1 sub-tasks completed')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Called tool' }));
    fireEvent.click(screen.getByRole('button', { name: 'Result' }));
    expect(screen.getByText('1 sub-tasks total: 1 succeeded, 0 failed')).toBeInTheDocument();
  });

  it('keeps the terminal batch card outside the collapsed work-process fold', () => {
    const userMessage: Message = {
      id: 'user-folded-batch',
      role: 'user',
      content: 'run a folded batch',
      timestamp: 1_000,
      loopId: 'loop-folded-batch',
      runState: 'completed',
      runEndedAt: 3_000,
    };
    const introMessage: Message = {
      id: 'assistant-folded-intro',
      role: 'assistant',
      content: 'Preparing the batch.',
      timestamp: 1_500,
      loopId: 'loop-folded-batch',
    };
    const batchMessage: Message = {
      id: 'assistant-folded-tool',
      role: 'assistant',
      content: '',
      timestamp: 2_000,
      loopId: 'loop-folded-batch',
      toolCalls: [{
        id: 'folded-batch-tool-call',
        name: TOOL_NAMES.RUN_AGENT_BATCH,
        input: { tasks: [{ task: 'inspect folded state' }] },
        result: '1 sub-tasks total: 1 succeeded, 0 failed',
      }],
    };
    const finalMessage: Message = {
      id: 'assistant-folded-final',
      role: 'assistant',
      content: 'Batch finished.',
      timestamp: 2_500,
      loopId: 'loop-folded-batch',
    };
    const messages = [userMessage, introMessage, batchMessage, finalMessage];
    const conversation: Conversation = {
      id: 'conversation-folded-batch',
      title: 'Folded batch task',
      messages,
      createdAt: 1_000,
      updatedAt: 3_000,
      status: 'idle',
    };
    useChatStore.setState({
      activeConversationId: conversation.id,
      conversations: { [conversation.id]: conversation },
      agentStatus: 'idle',
    });
    const store = useBatchProgressStore.getState();
    store.initBatch('folded-batch-tool-call', ['inspect folded state']);
    store.setTaskDone('folded-batch-tool-call', 0);

    render(<MessageGroup messages={messages} isLastGroup />);

    expect(screen.getByRole('button', { name: 'Worked for 2s' })).toBeInTheDocument();
    expect(screen.queryByText('Preparing the batch.')).toBeNull();
    expect(screen.getByText('Batch finished.')).toBeInTheDocument();
    expect(screen.getAllByText('✓ 1 sub-tasks completed')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Worked for 2s' }));
    expect(screen.getByText('Preparing the batch.')).toBeInTheDocument();
    expect(screen.getAllByText('✓ 1 sub-tasks completed')).toHaveLength(1);
  });
});
