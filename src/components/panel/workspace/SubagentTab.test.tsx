// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import {
  BATCH_PROGRESS_GLOBAL_RICH_CONTENT_BYTES,
  BATCH_PROGRESS_MAX_RICH_CONTENT_BYTES,
  useBatchProgressStore,
} from '@/stores/batchProgressStore';
import { makeBatchKey, type BatchIdentity } from '@/types';
import SubagentTab from './SubagentTab';

const identity: BatchIdentity = { conversationId: 'conv-subagent-tab', batchToolCallId: 'batch-1' };

function resetBatchStore() {
  useBatchProgressStore.setState({
    batches: {},
    activeVisibleBatchKey: undefined,
    richAccessClock: 0,
    richContentDiagnostics: {
      totalRetainedRichBytes: 0,
      retainedRichBytesCap: BATCH_PROGRESS_GLOBAL_RICH_CONTENT_BYTES,
      overageBytes: 0,
      evictionCount: 0,
      releasedBatchCount: 0,
      lastEvictedKey: undefined,
    },
  });
}

function seedRichStep() {
  const store = useBatchProgressStore.getState();
  store.initBatch(identity, ['Worker']);
  store.setTaskRunning(identity, 0);
  store.startTaskStep(identity, 0, {
    id: 'screenshot-step',
    toolName: 'abu-browser__screenshot',
    toolInput: { fullPage: true },
  });
  store.finishTaskStep(identity, 0, {
    id: 'screenshot-step',
    toolName: 'abu-browser__screenshot',
    result: 'Screenshot captured',
    resultContent: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } }],
    error: false,
  });
  store.setTaskTokenUsage(identity, 0, { inputTokens: 10, outputTokens: 5 });
}

describe('SubagentTab', () => {
  beforeEach(() => {
    initLanguage('en-US');
    resetBatchStore();
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders live status, tool detail, token usage, and retained screenshot rich content', () => {
    seedRichStep();

    render(<SubagentTab identity={identity} taskIndex={0} title="Worker A" />);

    expect(screen.getByText('Worker A')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('1 tool calls')).toBeInTheDocument();
    expect(screen.getByText('15 tokens')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Running · 1 tool calls · 15 tokens');
    expect(screen.getByRole('img', { name: /Screenshot captured/ })).toHaveAttribute(
      'src',
      'data:image/png;base64,aW1hZ2U=',
    );
  });

  it('replays a member process from the message snapshot when the live batch is gone', async () => {
    const { useChatStore } = await import('@/stores/chatStore');
    const convId = useChatStore.getState().createConversation(null, { skipActivate: true });
    useChatStore.getState().addMessage(convId, {
      id: 'assistant-1',
      role: 'assistant',
      content: 'done',
      timestamp: 1,
      executionSteps: [{
        id: 'batch-step', toolCallId: 'batch-persisted', type: 'delegate', label: 'batch', status: 'completed', toolName: 'run_agent_batch',
        childSteps: [
          { id: 'c0', toolCallId: 's0', type: 'tool', label: 'Read a.md', status: 'completed', toolName: 'read_file', batchTask: { index: 0, label: 'analyst' } },
          { id: 'c1', toolCallId: 's1', type: 'tool', label: 'Write report.md', status: 'completed', toolName: 'write_file', batchTask: { index: 1, label: 'writer' } },
        ],
      }],
    } as never);
    const persistedIdentity: BatchIdentity = { conversationId: convId, assistantMessageId: 'assistant-1', batchToolCallId: 'batch-persisted' };

    render(<SubagentTab identity={persistedIdentity} taskIndex={1} title="writer" />);

    expect(screen.getByText('writer')).toBeInTheDocument();
    expect(screen.getByText('Finished · recorded process')).toBeInTheDocument();
    const steps = screen.getByTestId('subagent-persisted-steps');
    // The stored label survives replay (toolInput is stripped from snapshots, so recomputing would degrade it).
    expect(steps).toHaveTextContent('Write report.md');
    expect(steps).not.toHaveTextContent('Read file');
    expect(screen.queryByText('The full subagent process is only retained during this app run.')).toBeNull();
  });

  it('uses the persisted child steps when a stale live dispatch still has zero steps', async () => {
    const { useChatStore } = await import('@/stores/chatStore');
    const { useTaskExecutionStore } = await import('@/stores/taskExecutionStore');
    const convId = useChatStore.getState().createConversation(null, { skipActivate: true });
    useChatStore.getState().addMessage(convId, {
      id: 'assistant-live-race',
      role: 'assistant',
      content: 'done',
      timestamp: 1,
      executionSteps: [{
        id: 'delegate-persisted', toolCallId: 'delegate-live-race', type: 'delegate', label: 'delegate', status: 'completed',
        toolName: 'delegate_to_agent', agentName: 'writer', childSteps: [{
          id: 'child-persisted', toolCallId: 'child-call', type: 'tool', label: 'Write report.md', status: 'completed', toolName: 'write_file',
          detailBlocks: [], source: 'agent', executionId: 'delegate-persisted', toolInput: {},
        }],
        detailBlocks: [], source: 'agent', executionId: 'exec-live-race', toolInput: {},
      }],
    } as never);
    const exec = useTaskExecutionStore.getState().createExecutionWithId(convId, 'loop-live-race', 'exec-live-race');
    useTaskExecutionStore.getState().addStep(exec.id, {
      id: 'delegate-live', executionId: exec.id, toolCallId: 'delegate-live-race', type: 'delegate', label: 'delegate', status: 'completed',
      toolName: 'delegate_to_agent', agentName: 'writer', childSteps: [], detailBlocks: [], source: 'agent', toolInput: {},
    });

    render(<SubagentTab identity={{ conversationId: convId, assistantMessageId: 'assistant-live-race', batchToolCallId: 'delegate-live-race' }} taskIndex={0} title="writer" />);

    expect(screen.getByText('1 tool calls')).toBeInTheDocument();
    expect(screen.getByTestId('subagent-persisted-steps')).toHaveTextContent('Write report.md');
    useTaskExecutionStore.getState().clearAll();
  });

  it('renders queued status with a static icon instead of a spinner', () => {
    useBatchProgressStore.getState().initBatch(identity, ['Worker']);

    const view = render(<SubagentTab identity={identity} taskIndex={0} title="Worker A" />);

    expect(screen.getByText('Queued')).toBeInTheDocument();
    expect(view.container.querySelector('.animate-spin')).toBeNull();
  });

  it('shows live activity and an explicit empty state before the first tool call', () => {
    const store = useBatchProgressStore.getState();
    store.initBatch(identity, ['Worker']);
    store.setTaskRunning(identity, 0);
    store.setTaskActivity(identity, 0, 'Planning the task', 1);

    render(<SubagentTab identity={identity} taskIndex={0} title="Worker A" />);

    expect(screen.getByRole('status')).toHaveTextContent('Planning the task');
    expect(screen.getByText('Planning the task', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('No tool calls have been retained yet.')).toBeInTheDocument();
  });

  it('shows a localized released-rich fallback while preserving the step shell', () => {
    seedRichStep();
    useBatchProgressStore.getState().setTaskTerminal(identity, 0, { status: 'succeeded', reason: 'completed' });
    useBatchProgressStore.getState().releaseBatchRichContent(identity);

    render(<SubagentTab identity={identity} taskIndex={0} title="Worker A" />);

    expect(screen.getByText('Succeeded')).toBeInTheDocument();
    expect(screen.getByText('[abu-browser] screenshot')).toBeInTheDocument();
    expect(useBatchProgressStore.getState().batches[makeBatchKey(identity)].tasks[0].steps[0].result)
      .toBe('Screenshot captured');
    expect(screen.getByText('Rich content for this step was released to keep memory bounded.')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('shows an omitted-rich fallback for admission-capped partial retention', () => {
    const store = useBatchProgressStore.getState();
    store.initBatch(identity, ['Worker']);
    store.finishTaskStep(identity, 0, {
      id: 'first',
      toolName: 'abu-browser__screenshot',
      result: 'first',
      resultContent: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a'.repeat(BATCH_PROGRESS_MAX_RICH_CONTENT_BYTES) } }],
      error: false,
    });
    store.finishTaskStep(identity, 0, {
      id: 'second',
      toolName: 'abu-browser__screenshot',
      result: 'second',
      resultContent: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YmJi' } }],
      error: false,
    });

    render(<SubagentTab identity={identity} taskIndex={0} title="Worker A" />);

    expect(screen.getByText('Some rich content for this step was omitted to keep memory bounded.')).toBeInTheDocument();
  });

  it('renders stopped running steps with explicit cancelled semantics', () => {
    const store = useBatchProgressStore.getState();
    store.initBatch(identity, ['Worker']);
    store.startTaskStep(identity, 0, {
      id: 'cancelled-step',
      toolName: 'read_file',
      toolInput: { path: '/tmp/a.md' },
    });
    store.setTaskTerminal(identity, 0, { status: 'stopped', reason: 'aborted' });

    render(<SubagentTab identity={identity} taskIndex={0} title="Worker A" />);

    expect(screen.getByText('Stopped')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: '[Cancelled]' })).toHaveTextContent('[Cancelled]');
  });

  it('shows the restart/unavailable fallback when the live batch entry is gone', () => {
    render(<SubagentTab identity={identity} taskIndex={0} title="Worker A" />);

    expect(screen.getByText('Worker A')).toBeInTheDocument();
    expect(screen.getByText('The full subagent process is only retained during this app run.')).toBeInTheDocument();
  });
});
