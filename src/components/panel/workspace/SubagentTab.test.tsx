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

  it('renders queued status with a static icon instead of a spinner', () => {
    useBatchProgressStore.getState().initBatch(identity, ['Worker']);

    const view = render(<SubagentTab identity={identity} taskIndex={0} title="Worker A" />);

    expect(screen.getByText('Queued')).toBeInTheDocument();
    expect(view.container.querySelector('.animate-spin')).toBeNull();
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
      resultContent: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'b' } }],
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
