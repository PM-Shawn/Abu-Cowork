// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { initLanguage } from '@/i18n';
import { useBatchProgressStore } from '@/stores/batchProgressStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useChatStore } from '@/stores/chatStore';
import { TOOL_NAMES } from '@/core/tools/toolNames';
import type { BatchIdentity, ToolCall } from '@/types';
import BatchProgress from './BatchProgress';

const identity: BatchIdentity = { conversationId: 'conv-batch-ui', batchToolCallId: 'batch-ui' };

function toolCall(id = identity.batchToolCallId, extra: Partial<ToolCall> = {}): ToolCall {
  return {
    id,
    name: TOOL_NAMES.RUN_AGENT_BATCH,
    input: { tasks: [{ task: 'Inspect page' }, { task: 'Write summary' }] },
    result: 'ok',
    ...extra,
  };
}

describe('BatchProgress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    initLanguage('en-US');
    useBatchProgressStore.setState({ batches: {}, activeVisibleBatchKey: undefined });
    usePreviewStore.setState({ tabs: [], activeTabId: null });
  });

  afterEach(() => {
    for (const entry of Object.values(useBatchProgressStore.getState().batches)) {
      useBatchProgressStore.getState().clearBatch(entry.identity);
    }
    cleanup();
    vi.useRealTimers();
  });

  it('renders live compact rows with last tool, elapsed, tool count, turn and tokens', () => {
    const store = useBatchProgressStore.getState();
    store.initBatch(identity, ['Inspect page']);
    store.setTaskRunning(identity, 0);
    store.setTaskActivity(identity, 0, 'Reading', 2);
    store.startTaskStep(identity, 0, { id: 'read-1', toolName: 'read_file', toolInput: { path: 'a.ts' } });
    store.finishTaskStep(identity, 0, { id: 'read-1', toolName: 'read_file', result: 'ok', error: false });
    store.setTaskTokenUsage(identity, 0, { inputTokens: 120, outputTokens: 45 });

    render(<BatchProgress identity={identity} toolCall={toolCall()} />);

    expect(screen.getByText('Running 1 parallel sub-tasks')).toBeInTheDocument();
    expect(screen.getByText('read_file')).toBeInTheDocument();
    expect(screen.getByText('1 tools')).toBeInTheDocument();
    expect(screen.getByText('165 tokens')).toBeInTheDocument();
    expect(screen.getByText('Turn 2')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByText('00:01')).toBeInTheDocument();
  });

  it('opens the matching subagent tab without cancelling work', () => {
    const cancelSpy = vi.spyOn(useChatStore.getState(), 'cancelStreaming');
    useBatchProgressStore.getState().initBatch(identity, ['Inspect page']);

    render(<BatchProgress identity={identity} toolCall={toolCall()} />);
    fireEvent.click(screen.getByRole('button', { name: /Open Inspect page/ }));

    const subagentTab = usePreviewStore.getState().tabs.find((tab) => tab.kind === 'subagent');
    expect(subagentTab).toMatchObject({ kind: 'subagent', identity, taskIndex: 0, title: 'Inspect page' });
    expect(cancelSpy).not.toHaveBeenCalled();
    cancelSpy.mockRestore();
  });

  it('stops the owning conversation, not the active conversation', () => {
    const cancelSpy = vi.spyOn(useChatStore.getState(), 'cancelStreaming');
    useChatStore.setState({ activeConversationId: 'other-conv' });
    useBatchProgressStore.getState().initBatch(identity, ['Inspect page']);

    render(<BatchProgress identity={identity} toolCall={toolCall()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

    expect(cancelSpy).toHaveBeenCalledWith(identity.conversationId);
    cancelSpy.mockRestore();
  });

  it('uses normalized persisted partial summaries and keeps missing tasks unknown', () => {
    render(<BatchProgress
      identity={identity}
      toolCall={toolCall(undefined, {
        batchTerminalSummary: {
          version: 1,
          batch: identity,
          taskCount: 2,
          counts: { succeeded: 1, failed: 0, stopped: 0, incomplete: 0 },
          tasks: [{ taskIndex: 0, status: 'succeeded', terminalReason: 'completed' }],
        },
      })}
    />);

    expect(screen.getByText('2 sub-tasks recorded')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open Inspect page.*Succeeded/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open Write summary.*Unknown/ })).toBeInTheDocument();
  });

  it('opens persisted rows as deduped workspace tabs without dialog or backdrop', () => {
    render(<BatchProgress
      identity={identity}
      toolCall={toolCall(undefined, {
        batchTerminalSummary: {
          version: 1,
          batch: identity,
          taskCount: 1,
          counts: { succeeded: 1, failed: 0, stopped: 0, incomplete: 0 },
          tasks: [{ taskIndex: 0, status: 'succeeded', terminalReason: 'completed' }],
        },
      })}
    />);

    const row = screen.getByRole('button', { name: /Open Inspect page.*Succeeded/ });
    fireEvent.click(row);
    fireEvent.click(row);

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(usePreviewStore.getState().tabs.filter((tab) => tab.kind === 'subagent')).toHaveLength(1);
  });

  it('rejects malformed persisted summaries and falls back to unknown bounded input rows', () => {
    render(<BatchProgress
      identity={identity}
      toolCall={toolCall(undefined, {
        batchTerminalSummary: {
          version: 1,
          batch: identity,
          taskCount: 9_999,
          counts: { succeeded: 0, failed: 0, stopped: 0, incomplete: 0 },
          tasks: [],
        } as ToolCall['batchTerminalSummary'],
      })}
    />);

    expect(screen.getByText('2 sub-tasks recorded')).toBeInTheDocument();
    expect(screen.getAllByText('Unknown')).toHaveLength(2);
  });

  it('clamps untrusted input task fallback rows to the UI task cap', () => {
    render(<BatchProgress
      identity={identity}
      toolCall={toolCall(undefined, {
        input: { tasks: Array.from({ length: 100 }, (_, i) => ({ task: `Task ${i + 1}` })) },
      })}
    />);

    expect(screen.getByText('16 sub-tasks recorded')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open Task 16.*Unknown/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open Task 17/ })).toBeNull();
  });
});
