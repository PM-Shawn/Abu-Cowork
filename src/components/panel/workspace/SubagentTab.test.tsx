// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import { requestDispatchCancel } from '@/core/agent/dispatchCancel';
import {
  BATCH_PROGRESS_GLOBAL_RICH_CONTENT_BYTES,
  BATCH_PROGRESS_MAX_RICH_CONTENT_BYTES,
  useBatchProgressStore,
} from '@/stores/batchProgressStore';
import { useChatStore } from '@/stores/chatStore';
import { useTaskExecutionStore } from '@/stores/taskExecutionStore';
import { makeBatchKey, type BatchIdentity } from '@/types';
import SubagentTab from './SubagentTab';

vi.mock('@/core/agent/dispatchCancel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/agent/dispatchCancel')>()),
  requestDispatchCancel: vi.fn(),
}));

const identity: BatchIdentity = { conversationId: 'conv-subagent-tab', batchToolCallId: 'batch-1' };

/** The header card of the tab: title, status and counters. */
function headerOf(container: HTMLElement): HTMLElement {
  const header = container.querySelector('header');
  if (!header) throw new Error('The tab has no header card');
  return header;
}

/** The hidden announcement for screen readers (the spinner is a second status region). */
function announcementOf(container: HTMLElement): HTMLElement {
  const region = container.querySelector<HTMLElement>('[role="status"][aria-live="polite"]');
  if (!region) throw new Error('The tab has no announcement region');
  return region;
}

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
    vi.mocked(requestDispatchCancel).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    // Conversations and live executions seeded by a test must not leak into
    // the next one — a failed assertion would otherwise skip the cleanup.
    useTaskExecutionStore.getState().clearAll();
    useChatStore.setState((state) => {
      state.conversations = {};
    });
  });

  it('renders live status, tool detail, token usage, and retained screenshot rich content', () => {
    seedRichStep();

    const view = render(<SubagentTab identity={identity} taskIndex={0} title="Worker A" />);

    expect(screen.getByText('Worker A')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('1 tool calls')).toBeInTheDocument();
    expect(screen.getByText('15 tokens')).toBeInTheDocument();
    const announcement = announcementOf(view.container);
    expect(announcement).toHaveTextContent('Running · 1 tool calls · 15 tokens');
    expect(announcement).toHaveClass('sr-only');
    expect(screen.getByRole('img', { name: /Screenshot captured/ })).toHaveAttribute(
      'src',
      'data:image/png;base64,aW1hZ2U=',
    );
  });

  it('replays a member process from the message snapshot when the live batch is gone', () => {
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
    expect(screen.queryByText('The full subagent trace is only retained during this app run.')).toBeNull();
  });

  // Real message shape (2026-09-16): the batch tool call lives on the loop's
  // dispatching assistant message (identity.assistantMessageId), while
  // persistExecutionSnapshot writes the steps onto the loop's LAST assistant
  // message. An earlier loop reusing the same provider tool-call id must not
  // be picked up.
  it('replays a member process when the steps snapshot and the batch tool call sit on different messages of the loop', () => {
    const convId = useChatStore.getState().createConversation(null, { skipActivate: true });
    const batchStep = (label: string) => ({
      id: `batch-step-${label}`, toolCallId: 'call_batch', type: 'delegate', label: 'batch', status: 'completed', toolName: 'run_agent_batch',
      childSteps: [
        { id: `c-${label}`, toolCallId: `s-${label}`, type: 'tool', label, status: 'completed', toolName: 'write_file', batchTask: { index: 0, label: 'writer' } },
      ],
    });
    const add = (message: object) => useChatStore.getState().addMessage(convId, message as never);
    add({ id: 'old-final', role: 'assistant', content: 'earlier', timestamp: 1, loopId: 'loop-old', executionSteps: [batchStep('Write stale.md')] });
    add({
      id: 'dispatch-msg', role: 'assistant', content: '', timestamp: 2, loopId: 'loop-new',
      toolCalls: [{
        id: 'call_batch', name: 'run_agent_batch', input: { tasks: [{ agent_name: 'writer', task: 'x' }] }, result: 'ok',
        batchTerminalSummary: {
          version: 1,
          batch: { conversationId: convId, assistantMessageId: 'dispatch-msg', batchToolCallId: 'call_batch' },
          taskCount: 1,
          counts: { succeeded: 1, failed: 0, stopped: 0, incomplete: 0 },
          tasks: [{ taskIndex: 0, status: 'succeeded', terminalReason: 'completed' }],
        },
      }],
    });
    add({ id: 'final-msg', role: 'assistant', content: 'done', timestamp: 3, loopId: 'loop-new', executionSteps: [batchStep('Write fresh.md')] });

    render(<SubagentTab identity={{ conversationId: convId, assistantMessageId: 'dispatch-msg', batchToolCallId: 'call_batch' }} taskIndex={0} title="writer" />);

    const steps = screen.getByTestId('subagent-persisted-steps');
    expect(steps).toHaveTextContent('Write fresh.md');
    expect(steps).not.toHaveTextContent('Write stale.md');
    expect(screen.getByText('Succeeded')).toBeInTheDocument();
  });

  it('keeps the child steps already shown when the next live update has zero steps', () => {
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
    // First update: the live dispatch still carries the member's child step.
    useTaskExecutionStore.getState().addStep(exec.id, {
      id: 'delegate-live', executionId: exec.id, toolCallId: 'delegate-live-race', type: 'delegate', label: 'delegate', status: 'completed',
      toolName: 'delegate_to_agent', agentName: 'writer', childSteps: [{
        id: 'child-live', toolCallId: 'child-call', type: 'tool', label: 'Write report.md', status: 'completed', toolName: 'write_file',
        detailBlocks: [], source: 'agent', executionId: exec.id, toolInput: {},
      }], detailBlocks: [], source: 'agent', toolInput: {},
    });

    render(<SubagentTab identity={{ conversationId: convId, assistantMessageId: 'assistant-live-race', batchToolCallId: 'delegate-live-race' }} taskIndex={0} title="writer" />);

    expect(screen.getByText('1 tool calls')).toBeInTheDocument();
    expect(screen.getByTestId('subagent-persisted-steps')).toHaveTextContent('Write report.md');

    // Second update: the completed execution is re-published with its child
    // steps already dropped, while the assistant message still holds them.
    act(() => {
      useTaskExecutionStore.setState((state) => {
        const liveStep = state.executions[exec.id]?.steps.find((step) => step.id === 'delegate-live');
        if (liveStep) liveStep.childSteps = [];
      });
    });

    expect(screen.getByText('1 tool calls')).toBeInTheDocument();
    expect(screen.getByTestId('subagent-persisted-steps')).toHaveTextContent('Write report.md');
  });

  it('renders queued status with a static icon instead of a spinner', () => {
    useBatchProgressStore.getState().initBatch(identity, ['Worker']);

    const view = render(<SubagentTab identity={identity} taskIndex={0} title="Worker A" />);

    expect(screen.getByText('Queued')).toBeInTheDocument();
    expect(view.container.querySelector('.animate-spin')).toBeNull();
    expect(screen.getByText('Queued')).toHaveClass('bg-fill');
    expect(screen.getByText('Queued').querySelector('svg.lucide-clock')).not.toBeNull();
  });

  it('shows one spinner in the header while the expert runs and a status tag once it finishes', () => {
    seedRichStep();

    const view = render(<SubagentTab identity={identity} taskIndex={0} title="Worker A" />);
    const header = headerOf(view.container);

    expect(header.querySelectorAll('[data-ds-spinner]')).toHaveLength(1);
    expect(view.container.querySelectorAll('[data-ds-spinner]')).toHaveLength(1);
    expect(within(header).getByText('Running')).not.toHaveClass('sr-only');
    // The spinner is inset so its word starts in the column of the tag that replaces it.
    expect(header.querySelector('[data-ds-spinner]')?.closest('[role="status"]')?.parentElement).toHaveClass('pl-1');

    act(() => {
      useBatchProgressStore.getState().setTaskTerminal(identity, 0, { status: 'succeeded', reason: 'completed' });
    });

    expect(headerOf(view.container).querySelector('[data-ds-spinner]')).toBeNull();
    const tag = within(headerOf(view.container)).getByText('Succeeded');
    expect(tag).toHaveClass('bg-success-soft');
    expect(tag).toHaveClass('text-success');
    expect(tag.querySelector('svg.text-success')).not.toBeNull();
  });

  it.each([
    { status: 'failed', reason: 'error', label: 'Failed', soft: 'bg-danger-soft', mark: 'svg.text-danger' },
    { status: 'incomplete', reason: 'max_turns', label: 'Incomplete', soft: 'bg-warning-soft', mark: 'svg.text-warning' },
    { status: 'stopped', reason: 'aborted', label: 'Stopped', soft: 'bg-fill', mark: 'svg.lucide-circle-stop' },
  ] as const)('marks a $status expert with a still tag whose colour comes with a shape', ({ status, reason, label, soft, mark }) => {
    const store = useBatchProgressStore.getState();
    store.initBatch(identity, ['Worker']);
    store.setTaskRunning(identity, 0);
    store.setTaskTerminal(identity, 0, { status, reason });

    const view = render(<SubagentTab identity={identity} taskIndex={0} title="Worker A" />);
    const header = headerOf(view.container);

    const tag = within(header).getByText(label);
    expect(tag).toHaveClass(soft);
    expect(tag.querySelector(mark)).not.toBeNull();
    expect(header.querySelector('[data-ds-spinner]')).toBeNull();
  });

  it('stops a hand-off that is still being recorded from the tab, with one spinner in the header', () => {
    const convId = useChatStore.getState().createConversation(null, { skipActivate: true });
    const exec = useTaskExecutionStore.getState().createExecutionWithId(convId, 'loop-stop', 'exec-stop');
    useTaskExecutionStore.getState().addStep(exec.id, {
      id: 'delegate-running', executionId: exec.id, toolCallId: 'delegate-stop', type: 'delegate', label: 'delegate', status: 'running',
      toolName: 'delegate_to_agent', agentName: 'writer', childSteps: [], detailBlocks: [], source: 'agent', toolInput: {},
    });

    const view = render(<SubagentTab identity={{ conversationId: convId, batchToolCallId: 'delegate-stop' }} taskIndex={0} title="writer" />);
    const header = headerOf(view.container);

    expect(header.querySelectorAll('[data-ds-spinner]')).toHaveLength(1);
    expect(within(header).getByText('Running')).not.toHaveClass('sr-only');
    expect(within(header).getByText('In progress')).toBeInTheDocument();

    const stop = within(header).getByRole('button', { name: 'Stop this hand-off to writer' });
    expect(stop).toHaveTextContent('Stop');
    expect(stop.querySelector('[data-ds-spinner]')).toBeNull();
    expect(requestDispatchCancel).not.toHaveBeenCalled();
    fireEvent.click(stop);
    expect(requestDispatchCancel).toHaveBeenCalledTimes(1);
    expect(requestDispatchCancel).toHaveBeenCalledWith('delegate-stop:0');
  });

  it('shows live activity and an explicit empty state before the first tool call', () => {
    const store = useBatchProgressStore.getState();
    store.initBatch(identity, ['Worker']);
    store.setTaskRunning(identity, 0);
    store.setTaskActivity(identity, 0, 'Planning the task', 1);

    const view = render(<SubagentTab identity={identity} taskIndex={0} title="Worker A" />);

    expect(announcementOf(view.container)).toHaveTextContent('Planning the task');
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
    expect(screen.getByText('The full subagent trace is only retained during this app run.')).toBeInTheDocument();
  });
});
