// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useBatchProgressStore } from '@/stores/batchProgressStore';
import { useWorkProcessFoldStore } from '@/stores/workProcessFoldStore';
import { TOOL_NAMES } from '@/core/tools/toolNames';
import type { Conversation, Message } from '@/types';
import MessageGroup from './MessageGroup';

function setConversationState(
  conversation: Conversation,
  agentStatus: 'idle' | 'tool-calling' = 'idle',
) {
  useChatStore.setState({
    activeConversationId: conversation.id,
    conversations: { [conversation.id]: conversation },
    agentStates: new Map(),
  });
  if (agentStatus !== 'idle') {
    useChatStore.getState().setAgentStatus(conversation.id, agentStatus);
  }
}

describe('MessageGroup stopped terminal', () => {
  beforeEach(() => {
    initLanguage('en-US');
  });

  afterEach(() => {
    for (const entry of Object.values(useBatchProgressStore.getState().batches)) {
      useBatchProgressStore.getState().clearBatch(entry.identity);
    }
    useWorkProcessFoldStore.getState().reset();
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
      agentStates: new Map(),
    });

    render(<MessageGroup conversationId={conversation.id} messages={[userMessage]} isLastGroup />);

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
    setConversationState(conversation);
    const store = useBatchProgressStore.getState();
    const identity = { conversationId: conversation.id, batchToolCallId: 'batch-tool-call' };
    store.initBatch(identity, ['inspect']);
    store.setTaskTerminal(identity, 0, { status: 'succeeded', reason: 'completed' });

    const view = render(<MessageGroup conversationId={conversation.id} messages={conversation.messages} isLastGroup />);

    expect(screen.getByText('✓ 1 sub-tasks completed')).toBeInTheDocument();
    store.clearBatch(identity);
    view.rerender(<MessageGroup conversationId={conversation.id} messages={conversation.messages} isLastGroup />);
    expect(screen.queryByText('✓ 1 sub-tasks completed')).toBeNull();
    expect(screen.getByText('1 sub-tasks recorded')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open inspect.*Unknown/ })).toBeInTheDocument();
  });

  it('folds terminal batch process details while keeping the final answer outside', async () => {
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
    setConversationState(conversation);
    const store = useBatchProgressStore.getState();
    const identity = { conversationId: conversation.id, batchToolCallId: 'folded-batch-tool-call' };
    store.initBatch(identity, ['inspect folded state']);
    store.setTaskTerminal(identity, 0, { status: 'succeeded', reason: 'completed' });

    render(<MessageGroup conversationId={conversation.id} messages={messages} isLastGroup />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Worked for 2s · 1 agents: 1 succeeded/ })).toHaveAttribute('aria-expanded', 'false');
    });
    expect(screen.queryByText('Preparing the batch.')).toBeNull();
    expect(screen.getByText('Batch finished.')).toBeInTheDocument();
    expect(screen.queryByText('✓ 1 sub-tasks completed')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Worked for 2s · 1 agents: 1 succeeded/ }));
    expect(screen.getByText('Preparing the batch.')).toBeInTheDocument();
    expect(screen.getAllByText('✓ 1 sub-tasks completed')).toHaveLength(1);
  });

  it('keeps manual collapse stable across rerender while the batch is running', () => {
    const userMessage: Message = {
      id: 'user-running-fold',
      role: 'user',
      content: 'run a batch',
      timestamp: 1_000,
      loopId: 'loop-running-fold',
      runState: 'running',
    };
    const assistantMessage: Message = {
      id: 'assistant-running-fold',
      role: 'assistant',
      content: '',
      timestamp: 2_000,
      loopId: 'loop-running-fold',
      toolCalls: [{
        id: 'running-fold-batch',
        name: TOOL_NAMES.RUN_AGENT_BATCH,
        input: { tasks: [{ task: 'inspect running' }] },
      }],
    };
    const messages = [userMessage, assistantMessage];
    const conversation: Conversation = {
      id: 'conversation-running-fold',
      title: 'Running batch',
      messages,
      createdAt: 1_000,
      updatedAt: 2_000,
      status: 'running',
    };
    setConversationState(conversation, 'tool-calling');
    const identity = { conversationId: conversation.id, batchToolCallId: 'running-fold-batch' };
    useBatchProgressStore.getState().initBatch(identity, ['inspect running']);
    useBatchProgressStore.getState().setTaskRunning(identity, 0);

    const view = render(<MessageGroup conversationId={conversation.id} messages={messages} isLastGroup />);
    const foldButton = screen.getByRole('button', { name: /1 agents: 1 running/ });
    expect(foldButton).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(foldButton);
    expect(screen.getByRole('button', { name: /1 agents: 1 running/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: /Open inspect running/ })).toBeNull();

    view.unmount();
    render(<MessageGroup conversationId={conversation.id} messages={messages} isLastGroup />);
    expect(screen.getByRole('button', { name: /1 agents: 1 running/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('does not re-auto-collapse after the user manually expands a successful fold', async () => {
    const userMessage: Message = {
      id: 'user-success-manual',
      role: 'user',
      content: 'run a batch',
      timestamp: 1_000,
      loopId: 'loop-success-manual',
      runState: 'completed',
      runEndedAt: 3_000,
    };
    const batchMessage: Message = {
      id: 'assistant-success-manual-batch',
      role: 'assistant',
      content: '',
      timestamp: 2_000,
      loopId: 'loop-success-manual',
      toolCalls: [{
        id: 'success-manual-batch',
        name: TOOL_NAMES.RUN_AGENT_BATCH,
        input: { tasks: [{ task: 'inspect success' }] },
      }],
    };
    const finalMessage: Message = {
      id: 'assistant-success-manual-final',
      role: 'assistant',
      content: 'Done.',
      timestamp: 3_000,
      loopId: 'loop-success-manual',
    };
    const messages = [userMessage, batchMessage, finalMessage];
    const conversation: Conversation = {
      id: 'conversation-success-manual',
      title: 'Success batch',
      messages,
      createdAt: 1_000,
      updatedAt: 3_000,
      status: 'idle',
    };
    setConversationState(conversation);
    const identity = { conversationId: conversation.id, batchToolCallId: 'success-manual-batch' };
    useBatchProgressStore.getState().initBatch(identity, ['inspect success']);
    useBatchProgressStore.getState().setTaskTerminal(identity, 0, { status: 'succeeded', reason: 'completed' });

    const view = render(<MessageGroup conversationId={conversation.id} messages={messages} isLastGroup />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /1 agents: 1 succeeded/ })).toHaveAttribute('aria-expanded', 'false');
    });
    fireEvent.click(screen.getByRole('button', { name: /1 agents: 1 succeeded/ }));
    expect(screen.getByRole('button', { name: /1 agents: 1 succeeded/ })).toHaveAttribute('aria-expanded', 'true');

    view.unmount();
    render(<MessageGroup conversationId={conversation.id} messages={messages} isLastGroup />);
    expect(screen.getByRole('button', { name: /1 agents: 1 succeeded/ })).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps failed batch process open with a perceivable failed aggregate', () => {
    const userMessage: Message = {
      id: 'user-failed-fold',
      role: 'user',
      content: 'run a failing batch',
      timestamp: 1_000,
      loopId: 'loop-failed-fold',
      runState: 'completed',
      runEndedAt: 3_000,
    };
    const batchMessage: Message = {
      id: 'assistant-failed-fold-batch',
      role: 'assistant',
      content: '',
      timestamp: 2_000,
      loopId: 'loop-failed-fold',
      toolCalls: [{
        id: 'failed-fold-batch',
        name: TOOL_NAMES.RUN_AGENT_BATCH,
        input: { tasks: [{ task: 'inspect failure' }] },
      }],
    };
    const finalMessage: Message = {
      id: 'assistant-failed-fold-final',
      role: 'assistant',
      content: 'Could not finish.',
      timestamp: 3_000,
      loopId: 'loop-failed-fold',
    };
    const messages = [userMessage, batchMessage, finalMessage];
    const conversation: Conversation = {
      id: 'conversation-failed-fold',
      title: 'Failed batch',
      messages,
      createdAt: 1_000,
      updatedAt: 3_000,
      status: 'idle',
    };
    setConversationState(conversation);
    const identity = { conversationId: conversation.id, batchToolCallId: 'failed-fold-batch' };
    useBatchProgressStore.getState().initBatch(identity, ['inspect failure']);
    useBatchProgressStore.getState().setTaskTerminal(identity, 0, { status: 'failed', reason: 'error' });

    render(<MessageGroup conversationId={conversation.id} messages={messages} isLastGroup />);

    expect(screen.getByRole('button', { name: /1 agents: 1 failed/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /Open inspect failure.*Failed/ })).toBeInTheDocument();
  });

  it.each([
    { status: 'stopped' as const, reason: 'aborted' as const, label: 'stopped', row: 'Stopped' },
    { status: 'incomplete' as const, reason: 'max_turns' as const, label: 'incomplete', row: 'Incomplete' },
  ])('keeps $label batch process open with a perceivable aggregate', ({ status, reason, label, row }) => {
    const userMessage: Message = {
      id: `user-${label}-fold`,
      role: 'user',
      content: `run a ${label} batch`,
      timestamp: 1_000,
      loopId: `loop-${label}-fold`,
      runState: 'completed',
      runEndedAt: 3_000,
    };
    const batchMessage: Message = {
      id: `assistant-${label}-fold-batch`,
      role: 'assistant',
      content: '',
      timestamp: 2_000,
      loopId: `loop-${label}-fold`,
      toolCalls: [{
        id: `${label}-fold-batch`,
        name: TOOL_NAMES.RUN_AGENT_BATCH,
        input: { tasks: [{ task: `inspect ${label}` }] },
      }],
    };
    const finalMessage: Message = {
      id: `assistant-${label}-fold-final`,
      role: 'assistant',
      content: 'Finished with non-success.',
      timestamp: 3_000,
      loopId: `loop-${label}-fold`,
    };
    const messages = [userMessage, batchMessage, finalMessage];
    const conversation: Conversation = {
      id: `conversation-${label}-fold`,
      title: `${label} batch`,
      messages,
      createdAt: 1_000,
      updatedAt: 3_000,
      status: 'idle',
    };
    setConversationState(conversation);
    const identity = { conversationId: conversation.id, batchToolCallId: `${label}-fold-batch` };
    useBatchProgressStore.getState().initBatch(identity, [`inspect ${label}`]);
    useBatchProgressStore.getState().setTaskTerminal(identity, 0, { status, reason });

    render(<MessageGroup conversationId={conversation.id} messages={messages} isLastGroup />);

    expect(screen.getByRole('button', { name: new RegExp(`1 agents: 1 ${label}`) })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: new RegExp(`Open inspect ${label}.*${row}`) })).toBeInTheDocument();
  });

  it('defers successful auto-collapse while focus is inside the work fold and re-evaluates on blur', async () => {
    const userMessage: Message = {
      id: 'user-focus-fold',
      role: 'user',
      content: 'run a batch',
      timestamp: 1_000,
      loopId: 'loop-focus-fold',
      runState: 'running',
    };
    const batchMessage: Message = {
      id: 'assistant-focus-fold-batch',
      role: 'assistant',
      content: '',
      timestamp: 2_000,
      loopId: 'loop-focus-fold',
      toolCalls: [{
        id: 'focus-fold-batch',
        name: TOOL_NAMES.RUN_AGENT_BATCH,
        input: { tasks: [{ task: 'inspect focus' }] },
      }],
    };
    const finalMessage: Message = {
      id: 'assistant-focus-fold-final',
      role: 'assistant',
      content: 'Done.',
      timestamp: 3_000,
      loopId: 'loop-focus-fold',
    };
    const messages = [userMessage, batchMessage, finalMessage];
    const conversation: Conversation = {
      id: 'conversation-focus-fold',
      title: 'Focus batch',
      messages,
      createdAt: 1_000,
      updatedAt: 3_000,
      status: 'running',
    };
    setConversationState(conversation, 'tool-calling');
    const identity = { conversationId: conversation.id, batchToolCallId: 'focus-fold-batch' };
    const store = useBatchProgressStore.getState();
    store.initBatch(identity, ['inspect focus']);
    store.setTaskRunning(identity, 0);

    const view = render(<MessageGroup conversationId={conversation.id} messages={messages} isLastGroup />);
    const taskRow = screen.getByRole('button', { name: /Open inspect focus.*Running/ });
    taskRow.focus();

    store.setTaskTerminal(identity, 0, { status: 'succeeded', reason: 'completed' });
    useChatStore.setState({ conversations: { [conversation.id]: { ...conversation, status: 'idle' } } });
    view.rerender(<MessageGroup conversationId={conversation.id} messages={messages} isLastGroup />);

    expect(screen.getByRole('button', { name: /1 agents: 1 succeeded/ })).toHaveAttribute('aria-expanded', 'true');
    taskRow.blur();
    fireEvent.focusOut(taskRow, { relatedTarget: document.body });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /1 agents: 1 succeeded/ })).toHaveAttribute('aria-expanded', 'false');
    });
  });
});
