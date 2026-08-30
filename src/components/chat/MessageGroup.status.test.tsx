// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('keeps a terminal batch card visible and falls back to its legacy result after live eviction', () => {
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
    const identity = {
      conversationId: conversation.id,
      assistantMessageId: assistantMessage.id,
      batchToolCallId: 'batch-tool-call',
    };
    store.initBatch(identity, ['inspect']);
    store.setTaskTerminal(identity, 0, { status: 'succeeded', reason: 'completed' });

    const view = render(<MessageGroup conversationId={conversation.id} messages={conversation.messages} isLastGroup />);

    expect(screen.getByText('✓ 1 sub-tasks completed')).toBeInTheDocument();
    store.clearBatch(identity);
    view.rerender(<MessageGroup conversationId={conversation.id} messages={conversation.messages} isLastGroup />);
    expect(screen.getByText('✓ 1 sub-tasks completed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open inspect.*Succeeded/ })).toBeInTheDocument();
  });

  it('keeps text-first output visible when process work has no closing answer', () => {
    const userMessage: Message = {
      id: 'user-text-first',
      role: 'user',
      content: 'inspect this',
      timestamp: 1_000,
      loopId: 'loop-text-first',
      runState: 'completed',
      runEndedAt: 3_000,
    };
    const introMessage: Message = {
      id: 'assistant-text-first-intro',
      role: 'assistant',
      content: 'I will inspect the workspace first.',
      timestamp: 1_500,
      loopId: 'loop-text-first',
    };
    const batchMessage: Message = {
      id: 'assistant-text-first-batch',
      role: 'assistant',
      content: '',
      timestamp: 2_000,
      loopId: 'loop-text-first',
      toolCalls: [{
        id: 'text-first-batch',
        name: TOOL_NAMES.RUN_AGENT_BATCH,
        input: { tasks: [{ task: 'inspect workspace' }] },
        result: '1 sub-tasks total: 1 succeeded, 0 failed',
      }],
    };
    const conversation: Conversation = {
      id: 'conversation-text-first',
      title: 'Text first',
      messages: [userMessage, introMessage, batchMessage],
      createdAt: 1_000,
      updatedAt: 3_000,
      status: 'idle',
    };
    setConversationState(conversation);

    render(<MessageGroup conversationId={conversation.id} messages={conversation.messages} isLastGroup />);

    const foldButton = screen.queryByRole('button', { name: /Worked for/ });
    if (foldButton?.getAttribute('aria-expanded') === 'true') fireEvent.click(foldButton);
    expect(screen.getByText('I will inspect the workspace first.')).toBeInTheDocument();
  });

  it('renders running work inline without a fold header, keeping streaming text visible', () => {
    const userMessage: Message = {
      id: 'user-streaming-text',
      role: 'user',
      content: 'stream progress',
      timestamp: 1_000,
      loopId: 'loop-streaming-text',
      runState: 'running',
    };
    const batchMessage: Message = {
      id: 'assistant-streaming-batch',
      role: 'assistant',
      content: '',
      timestamp: 1_500,
      loopId: 'loop-streaming-text',
      toolCalls: [{
        id: 'streaming-text-batch',
        name: TOOL_NAMES.RUN_AGENT_BATCH,
        input: { tasks: [{ task: 'inspect live state' }] },
        isExecuting: true,
      }],
    };
    const streamingMessage: Message = {
      id: 'assistant-streaming-text',
      role: 'assistant',
      content: 'The first result is already available.',
      timestamp: 2_000,
      loopId: 'loop-streaming-text',
      isStreaming: true,
    };
    const conversation: Conversation = {
      id: 'conversation-streaming-text',
      title: 'Streaming text',
      messages: [userMessage, batchMessage, streamingMessage],
      createdAt: 1_000,
      updatedAt: 2_000,
      status: 'running',
    };
    setConversationState(conversation, 'tool-calling');
    const identity = {
      conversationId: conversation.id,
      assistantMessageId: batchMessage.id,
      batchToolCallId: 'streaming-text-batch',
    };
    useBatchProgressStore.getState().initBatch(identity, ['inspect live state']);
    useBatchProgressStore.getState().setTaskRunning(identity, 0);

    render(<MessageGroup conversationId={conversation.id} messages={conversation.messages} isLastGroup />);

    // In-progress runs render their work inline: no fold wrapper exists yet
    // (the "Worked for" header is a settled-turn summary — see
    // computeWorkProcessFold), so the live batch card and the streaming text
    // are both directly visible, under the non-interactive ticking divider.
    expect(screen.queryByRole('button', { name: /1 agents: 1 running/ })).toBeNull();
    expect(screen.queryByText(/Worked for/)).toBeNull();
    expect(screen.getByText(/Working/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open inspect live state.*Running/ })).toBeInTheDocument();
    expect(screen.getByText('The first result is already available.')).toBeInTheDocument();
  });

  it('keeps a mid-loop user message visible after collapsing preceding work', () => {
    const userMessage: Message = {
      id: 'user-mid-loop-fold',
      role: 'user',
      content: 'start the batch',
      timestamp: 1_000,
      loopId: 'loop-mid-user-fold',
      runState: 'completed',
      runEndedAt: 3_000,
    };
    const batchMessage: Message = {
      id: 'assistant-mid-user-batch',
      role: 'assistant',
      content: '',
      timestamp: 1_500,
      loopId: 'loop-mid-user-fold',
      toolCalls: [{
        id: 'mid-user-batch',
        name: TOOL_NAMES.RUN_AGENT_BATCH,
        input: { tasks: [{ task: 'inspect before follow-up' }] },
        result: '1 sub-tasks total: 1 succeeded, 0 failed',
      }],
    };
    const midUserMessage: Message = {
      id: 'user-mid-loop-follow-up',
      role: 'user',
      content: 'Also include the follow-up details.',
      timestamp: 2_000,
      loopId: 'loop-mid-user-fold',
    };
    const finalMessage: Message = {
      id: 'assistant-mid-user-final',
      role: 'assistant',
      content: 'The batch and follow-up are complete.',
      timestamp: 2_500,
      loopId: 'loop-mid-user-fold',
    };
    const conversation: Conversation = {
      id: 'conversation-mid-user-fold',
      title: 'Mid-loop user fold',
      messages: [userMessage, batchMessage, midUserMessage, finalMessage],
      createdAt: 1_000,
      updatedAt: 3_000,
      status: 'idle',
    };
    setConversationState(conversation);
    const identity = {
      conversationId: conversation.id,
      assistantMessageId: batchMessage.id,
      batchToolCallId: 'mid-user-batch',
    };
    useBatchProgressStore.getState().initBatch(identity, ['inspect before follow-up']);
    useBatchProgressStore.getState().setTaskTerminal(identity, 0, { status: 'succeeded', reason: 'completed' });

    render(<MessageGroup conversationId={conversation.id} messages={conversation.messages} isLastGroup />);

    const foldButton = screen.getByRole('button', { name: /1 agents: 1 succeeded/ });
    if (foldButton.getAttribute('aria-expanded') === 'true') fireEvent.click(foldButton);
    expect(foldButton).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Also include the follow-up details.')).toBeInTheDocument();
    expect(screen.getByText('The batch and follow-up are complete.')).toBeInTheDocument();
  });

  it('infers a legacy result-only batch and auto-collapses without unknown rows', async () => {
    const userMessage: Message = {
      id: 'user-legacy-result-fold',
      role: 'user',
      content: 'run the legacy batch',
      timestamp: 1_000,
      loopId: 'loop-legacy-result-fold',
      runState: 'completed',
      runEndedAt: 3_000,
    };
    const batchMessage: Message = {
      id: 'assistant-legacy-result-batch',
      role: 'assistant',
      content: '',
      timestamp: 1_500,
      loopId: 'loop-legacy-result-fold',
      toolCalls: [{
        id: 'legacy-result-batch',
        name: TOOL_NAMES.RUN_AGENT_BATCH,
        input: { tasks: [{ task: 'inspect legacy state' }] },
        result: '1 sub-tasks total: 1 succeeded, 0 failed',
      }],
    };
    const finalMessage: Message = {
      id: 'assistant-legacy-result-final',
      role: 'assistant',
      content: 'Legacy batch finished.',
      timestamp: 2_500,
      loopId: 'loop-legacy-result-fold',
    };
    const conversation: Conversation = {
      id: 'conversation-legacy-result-fold',
      title: 'Legacy result fold',
      messages: [userMessage, batchMessage, finalMessage],
      createdAt: 1_000,
      updatedAt: 3_000,
      status: 'idle',
    };
    setConversationState(conversation);

    render(<MessageGroup conversationId={conversation.id} messages={conversation.messages} isLastGroup />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /1 agents: 1 succeeded/ })).toHaveAttribute('aria-expanded', 'false');
    });
    expect(screen.queryByText('Unknown')).toBeNull();
    expect(screen.getByText('Legacy batch finished.')).toBeInTheDocument();
  });

  it('keeps the live reused-id batch card and renders an unrecognized legacy result generically', () => {
    const userMessage: Message = {
      id: 'user-reused-batch-id',
      role: 'user',
      content: 'run two batches',
      timestamp: 1_000,
      loopId: 'loop-reused-batch-id',
      runState: 'completed',
    };
    const batchCall = (task: string) => ({
      id: 'call_1',
      name: TOOL_NAMES.RUN_AGENT_BATCH,
      input: { tasks: [{ task }] },
      result: 'done',
    });
    const first: Message = {
      id: 'assistant-reused-1',
      role: 'assistant',
      content: '',
      timestamp: 2_000,
      loopId: 'loop-reused-batch-id',
      toolCalls: [batchCall('first batch')],
    };
    const second: Message = {
      id: 'assistant-reused-2',
      role: 'assistant',
      content: '',
      timestamp: 3_000,
      loopId: 'loop-reused-batch-id',
      toolCalls: [batchCall('second batch')],
    };
    const conversation: Conversation = {
      id: 'conversation-reused-batch-id',
      title: 'Reused batch ids',
      messages: [userMessage, first, second],
      createdAt: 1_000,
      updatedAt: 3_000,
      status: 'idle',
    };
    setConversationState(conversation);

    const store = useBatchProgressStore.getState();
    const firstIdentity = {
      conversationId: conversation.id,
      assistantMessageId: first.id,
      batchToolCallId: 'call_1',
    };
    store.initBatch(firstIdentity, ['first live batch']);
    store.setTaskTerminal(firstIdentity, 0, { status: 'succeeded', reason: 'completed' });
    // A v1 fallback entry is still valid for a legacy-only reload, but must
    // not be reused by the second v2 assistant message in this live view.
    store.initBatch({ conversationId: conversation.id, batchToolCallId: 'call_1' }, ['legacy fallback']);

    render(<MessageGroup conversationId={conversation.id} messages={conversation.messages} isLastGroup />);

    expect(screen.getByText('✓ 1 sub-tasks completed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open first live batch.*Succeeded/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open second batch/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Called tool' })).toBeInTheDocument();
  });

  it('renders the raw result generically when persisted batch metadata is malformed', () => {
    const userMessage: Message = {
      id: 'user-malformed-batch-summary',
      role: 'user',
      content: 'replay malformed batch metadata',
      timestamp: 1_000,
      loopId: 'loop-malformed-batch-summary',
      runState: 'completed',
      runEndedAt: 3_000,
    };
    const assistantMessage: Message = {
      id: 'assistant-malformed-batch-summary',
      role: 'assistant',
      content: '',
      timestamp: 2_000,
      loopId: 'loop-malformed-batch-summary',
      toolCalls: [{
        id: 'malformed-batch-summary',
        name: TOOL_NAMES.RUN_AGENT_BATCH,
        input: { tasks: [{ task: 'inspect malformed state' }] },
        result: 'unrecognized legacy batch output',
        batchTerminalSummary: {
          version: 1,
          batch: {
            conversationId: 'wrong-conversation',
            assistantMessageId: 'wrong-message',
            batchToolCallId: 'malformed-batch-summary',
          },
          taskCount: 1,
          counts: { succeeded: 1, failed: 0, stopped: 0, incomplete: 0 },
          tasks: [{ taskIndex: 0, status: 'succeeded', terminalReason: 'completed' }],
        },
      }],
    };
    const conversation: Conversation = {
      id: 'conversation-malformed-batch-summary',
      title: 'Malformed batch summary',
      messages: [userMessage, assistantMessage],
      createdAt: 1_000,
      updatedAt: 3_000,
      status: 'idle',
    };
    setConversationState(conversation);

    render(<MessageGroup conversationId={conversation.id} messages={conversation.messages} isLastGroup />);

    const genericTool = screen.getByRole('button', { name: 'Called tool' });
    expect(screen.queryByRole('button', { name: /Open inspect malformed state/ })).toBeNull();
    fireEvent.click(genericTool);
    fireEvent.click(screen.getByRole('button', { name: 'Result' }));
    expect(screen.getByText('unrecognized legacy batch output')).toBeInTheDocument();
  });

  it('keeps authored preamble text visible when process work follows it', () => {
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
    const identity = {
      conversationId: conversation.id,
      assistantMessageId: batchMessage.id,
      batchToolCallId: 'folded-batch-tool-call',
    };
    store.initBatch(identity, ['inspect folded state']);
    store.setTaskTerminal(identity, 0, { status: 'succeeded', reason: 'completed' });

    render(<MessageGroup conversationId={conversation.id} messages={messages} isLastGroup />);

    // The whole work process (intro + batch) folds behind the header, and the
    // successful batch auto-collapses — but authored text must survive the
    // collapsed state: only the batch card itself hides.
    const foldHeader = screen.getByRole('button', { name: /1 agents: 1 succeeded/ });
    expect(foldHeader).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Preparing the batch.')).toBeInTheDocument();
    expect(screen.getByText('Batch finished.')).toBeInTheDocument();
    expect(screen.queryByText('✓ 1 sub-tasks completed')).toBeNull();

    fireEvent.click(foldHeader);
    expect(screen.getByText('Preparing the batch.')).toBeInTheDocument();
    expect(screen.getAllByText('✓ 1 sub-tasks completed')).toHaveLength(1);
  });

  it('keeps process-only running work visible with no fold header until the run settles', () => {
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
    const identity = {
      conversationId: conversation.id,
      assistantMessageId: assistantMessage.id,
      batchToolCallId: 'running-fold-batch',
    };
    useBatchProgressStore.getState().initBatch(identity, ['inspect running']);
    useBatchProgressStore.getState().setTaskRunning(identity, 0);

    const view = render(<MessageGroup conversationId={conversation.id} messages={messages} isLastGroup />);
    // Running work renders inline — no fold header exists until the run
    // settles (only the non-interactive ticking divider), and the live batch
    // card stays visible, across remounts.
    expect(screen.queryByRole('button', { name: /1 agents: 1 running/ })).toBeNull();
    expect(screen.getByText(/Working/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open inspect running/ })).toBeInTheDocument();

    view.unmount();
    render(<MessageGroup conversationId={conversation.id} messages={messages} isLastGroup />);
    expect(screen.queryByRole('button', { name: /1 agents: 1 running/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Open inspect running/ })).toBeInTheDocument();
  });

  it('never shows the "Worked for" header mid-run; it appears only once the run settles', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(5_000);
    try {
      runFoldLifecycle();
    } finally {
      vi.useRealTimers();
    }
  });

  function runFoldLifecycle() {
    const userMessage: Message = {
      id: 'user-lifecycle',
      role: 'user',
      content: 'run the lifecycle batch',
      timestamp: 1_000,
      loopId: 'loop-lifecycle',
      runState: 'running',
    };
    const placeholder: Message = {
      id: 'assistant-lifecycle',
      role: 'assistant',
      content: '',
      timestamp: 1_100,
      loopId: 'loop-lifecycle',
      isStreaming: true,
    };
    const conversation: Conversation = {
      id: 'conversation-lifecycle',
      title: 'Lifecycle',
      messages: [userMessage, placeholder],
      createdAt: 1_000,
      updatedAt: 1_100,
      status: 'running',
    };
    setConversationState(conversation);

    // Phase 1 — fresh placeholder: typing dots only, no divider and no fold
    // header row yet.
    const view = render(
      <MessageGroup conversationId={conversation.id} messages={[userMessage, placeholder]} isLastGroup />,
    );
    expect(document.querySelector('.typing-dot')).not.toBeNull();
    expect(screen.queryByText(/Worked for/)).toBeNull();
    expect(screen.queryByText(/Working/)).toBeNull();

    // Phase 2 — first process content arrives: the ticking in-run divider
    // takes the dots' slot (progressive wording, not a button), and the
    // settled "Worked for" header still does not exist.
    const batchMessage: Message = {
      ...placeholder,
      toolCalls: [{
        id: 'lifecycle-batch',
        name: TOOL_NAMES.RUN_AGENT_BATCH,
        input: { tasks: [{ task: 'inspect lifecycle' }] },
        isExecuting: true,
      }],
    };
    const identity = {
      conversationId: conversation.id,
      assistantMessageId: batchMessage.id,
      batchToolCallId: 'lifecycle-batch',
    };
    useBatchProgressStore.getState().initBatch(identity, ['inspect lifecycle']);
    useBatchProgressStore.getState().setTaskRunning(identity, 0);
    view.rerender(
      <MessageGroup conversationId={conversation.id} messages={[userMessage, batchMessage]} isLastGroup />,
    );
    expect(screen.getByRole('button', { name: /Open inspect lifecycle.*Running/ })).toBeInTheDocument();
    expect(screen.queryByText(/Worked for/)).toBeNull();
    // Divider: elapsed = now(5s) - workStart(1s) = 4s, ticking every second.
    expect(screen.getByText('Working for 4s')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Working for/ })).toBeNull();
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getByText('Working for 6s')).toBeInTheDocument();

    // Phase 3 — run settles: the ticking divider hands its slot to the fold
    // header, now truthfully in the past tense, with the completion collapse.
    useBatchProgressStore.getState().setTaskTerminal(identity, 0, { status: 'succeeded', reason: 'completed' });
    const settledUser: Message = { ...userMessage, runState: 'completed', runEndedAt: 3_000 };
    const settledBatch: Message = { ...batchMessage, isStreaming: false };
    const finalMessage: Message = {
      id: 'assistant-lifecycle-final',
      role: 'assistant',
      content: 'Lifecycle finished.',
      timestamp: 2_900,
      loopId: 'loop-lifecycle',
    };
    useChatStore.setState({
      conversations: { [conversation.id]: { ...conversation, status: 'idle' } },
    });
    view.rerender(
      <MessageGroup conversationId={conversation.id} messages={[settledUser, settledBatch, finalMessage]} isLastGroup />,
    );
    expect(screen.getByText(/Worked for/)).toBeInTheDocument();
    expect(screen.queryByText(/Working for/)).toBeNull();
  }

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
    const identity = {
      conversationId: conversation.id,
      assistantMessageId: batchMessage.id,
      batchToolCallId: 'success-manual-batch',
    };
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
    const identity = {
      conversationId: conversation.id,
      assistantMessageId: batchMessage.id,
      batchToolCallId: 'failed-fold-batch',
    };
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
    const identity = {
      conversationId: conversation.id,
      assistantMessageId: batchMessage.id,
      batchToolCallId: `${label}-fold-batch`,
    };
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
    const identity = {
      conversationId: conversation.id,
      assistantMessageId: batchMessage.id,
      batchToolCallId: 'focus-fold-batch',
    };
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
