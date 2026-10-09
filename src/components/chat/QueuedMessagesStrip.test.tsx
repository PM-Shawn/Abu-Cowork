// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
/**
 * Queued follow-ups render as light-gray pills at the composer's top-right
 * edge, each cancellable. They are not transcript turns until the current
 * task has reached a terminal state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render as renderBare, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps, ReactElement, ReactNode } from 'react';
import { DesignSystemProvider } from '@/components/ds/provider';
import QueuedMessagesStrip from './QueuedMessagesStrip';
import { AgentLoopDispatchError } from '@/core/agent/agentLoopDispatchError';
import {
  enqueueUserInput,
  clearInputQueue,
  getQueuedInputs,
  pauseUserInputQueue,
} from '@/core/agent/userInputQueue';

const runAgentLoopDispatchedMock = vi.fn().mockResolvedValue({ reason: 'completed' });

vi.mock('@/core/agent/agentLoopRunner', () => ({
  runAgentLoopDispatched: (...args: unknown[]) => runAgentLoopDispatchedMock(...args),
}));

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      queueStrip: {
        queuedHint: '已排队',
        cancel: '取消排队',
        paused: '当前回复已停止，队列已暂停',
        resume: '继续队列',
      },
    },
  }),
}));

const iconButtonRenders = vi.hoisted(() => vi.fn());

// Counts renders of the pills' only floating-layer control (the cancel button's tooltip).
vi.mock('@/components/ds/button', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/button')>();
  return {
    ...actual,
    IconButton: (props: ComponentProps<typeof actual.IconButton>) => {
      iconButtonRenders();
      return actual.IconButton(props);
    },
  };
});

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

// Stands in for ChatView re-rendering on every streamed token: `tick` changes, the strip's props do not.
function Host({ tick, children }: { tick: number; children: ReactNode }) {
  return <DesignSystemProvider><span data-tick={tick} />{children}</DesignSystemProvider>;
}

const CONV = 'conv-strip';

describe('QueuedMessagesStrip', () => {
  beforeEach(() => {
    clearInputQueue(CONV);
    runAgentLoopDispatchedMock.mockClear();
  });
  afterEach(() => {
    cleanup();
    clearInputQueue(CONV);
  });

  it('renders nothing when the queue is empty', () => {
    const { container } = render(<QueuedMessagesStrip conversationId={CONV} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a pill per queued message', () => {
    enqueueUserInput(CONV, '数完说你好');
    enqueueUserInput(CONV, '再说声晚安');
    render(<QueuedMessagesStrip conversationId={CONV} />);
    expect(screen.getByText('数完说你好')).toBeInTheDocument();
    expect(screen.getByText('再说声晚安')).toBeInTheDocument();
  });

  it('hides system-injected queue items', () => {
    enqueueUserInput(CONV, '后台结果', true);
    const { container } = render(<QueuedMessagesStrip conversationId={CONV} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('the × cancels a queued message before handoff', async () => {
    const user = userEvent.setup();
    enqueueUserInput(CONV, '取消我');
    render(<QueuedMessagesStrip conversationId={CONV} />);

    await user.click(screen.getByLabelText('取消排队'));

    expect(screen.queryByText('取消我')).not.toBeInTheDocument();
    expect(getQueuedInputs(CONV)).toHaveLength(0);
  });

  it('draws each queued message as a filled block whose cancel button is named, without a native title', () => {
    enqueueUserInput(CONV, '排队中');
    render(<QueuedMessagesStrip conversationId={CONV} />);
    const cancel = screen.getByRole('button', { name: '取消排队' });
    expect(cancel).not.toHaveAttribute('title');
    const block = cancel.parentElement!;
    expect(block).toHaveClass('rounded-control');
    expect(block).toHaveClass('bg-fill');
  });

  it('does not re-render the cancel buttons while the chat view streams', () => {
    enqueueUserInput(CONV, '第一条');
    const { rerender } = renderBare(<Host tick={0}><QueuedMessagesStrip conversationId={CONV} /></Host>);
    const initial = iconButtonRenders.mock.calls.length;
    expect(initial).toBeGreaterThan(0);
    rerender(<Host tick={1}><QueuedMessagesStrip conversationId={CONV} /></Host>);
    rerender(<Host tick={2}><QueuedMessagesStrip conversationId={CONV} /></Host>);
    expect(iconButtonRenders).toHaveBeenCalledTimes(initial);
  });

  it('shows a paused terminal after Stop and resumes the oldest item as a new run', async () => {
    const user = userEvent.setup();
    enqueueUserInput(CONV, '第一条');
    enqueueUserInput(CONV, '第二条');
    pauseUserInputQueue(CONV);
    render(<QueuedMessagesStrip conversationId={CONV} />);

    expect(screen.getByText('当前回复已停止，队列已暂停')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '继续队列' }));

    await vi.waitFor(() => {
      expect(runAgentLoopDispatchedMock).toHaveBeenCalledWith(CONV, '第一条', { initiatedBy: 'user' });
    });
    expect(getQueuedInputs(CONV).map((item) => item.text)).toEqual(['第二条']);
    expect(screen.getByText('当前回复已停止，队列已暂停')).toBeInTheDocument();
  });

  it('restores the oldest item at the front when resume throws before acceptance', async () => {
    const user = userEvent.setup();
    runAgentLoopDispatchedMock.mockRejectedValueOnce(new Error('startup failed'));
    enqueueUserInput(CONV, '第一条');
    enqueueUserInput(CONV, '第二条');
    pauseUserInputQueue(CONV);
    render(<QueuedMessagesStrip conversationId={CONV} />);

    await user.click(screen.getByRole('button', { name: '继续队列' }));

    await vi.waitFor(() => {
      expect(screen.getByText('当前回复已停止，队列已暂停')).toBeInTheDocument();
    });
    expect(getQueuedInputs(CONV).map((item) => item.text)).toEqual(['第一条', '第二条']);
  });

  it('restores the oldest item at the front when resume is rejected', async () => {
    const user = userEvent.setup();
    runAgentLoopDispatchedMock.mockResolvedValueOnce({
      reason: 'error',
      error: 'conversation busy',
      messageTaken: false,
    });
    enqueueUserInput(CONV, '第一条');
    enqueueUserInput(CONV, '第二条');
    pauseUserInputQueue(CONV);
    render(<QueuedMessagesStrip conversationId={CONV} />);

    await user.click(screen.getByRole('button', { name: '继续队列' }));

    await vi.waitFor(() => {
      expect(getQueuedInputs(CONV).map((item) => item.text)).toEqual(['第一条', '第二条']);
    });
    expect(screen.getByText('当前回复已停止，队列已暂停')).toBeInTheDocument();
  });

  it('does not requeue an item after dispatch accepted it and then rejected', async () => {
    const user = userEvent.setup();
    runAgentLoopDispatchedMock.mockRejectedValueOnce(
      new AgentLoopDispatchError(new Error('terminal persistence failed'), true),
    );
    enqueueUserInput(CONV, '第一条');
    enqueueUserInput(CONV, '第二条');
    pauseUserInputQueue(CONV);
    render(<QueuedMessagesStrip conversationId={CONV} />);

    await user.click(screen.getByRole('button', { name: '继续队列' }));

    await vi.waitFor(() => {
      expect(getQueuedInputs(CONV).map((item) => item.text)).toEqual(['第二条']);
    });
    expect(screen.getByText('当前回复已停止，队列已暂停')).toBeInTheDocument();
  });
  it('preserves the approval selection when resuming its paused retry turn', async () => {
    const user = userEvent.setup();
    enqueueUserInput(CONV, 'selected retry', false, 'approval-1');
    pauseUserInputQueue(CONV);
    render(<QueuedMessagesStrip conversationId={CONV} />);
    await user.click(screen.getByRole('button', { name: '继续队列' }));
    expect(runAgentLoopDispatchedMock).toHaveBeenCalledWith(CONV, 'selected retry', {
      initiatedBy: 'user', teamConfirmationRetryId: 'approval-1',
    });
  });

});
