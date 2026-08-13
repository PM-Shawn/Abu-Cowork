/// <reference types="@testing-library/jest-dom" />
/**
 * Queued follow-ups render as light-gray pills at the composer's top-right
 * edge, each cancellable. They are not transcript turns until the current
 * task has reached a terminal state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import QueuedMessagesStrip from './QueuedMessagesStrip';
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

  it('shows a paused terminal after Stop and resumes the oldest item as a new run', async () => {
    const user = userEvent.setup();
    enqueueUserInput(CONV, '第一条');
    enqueueUserInput(CONV, '第二条');
    pauseUserInputQueue(CONV);
    render(<QueuedMessagesStrip conversationId={CONV} />);

    expect(screen.getByText('当前回复已停止，队列已暂停')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '继续队列' }));

    await vi.waitFor(() => {
      expect(runAgentLoopDispatchedMock).toHaveBeenCalledWith(CONV, '第一条');
    });
    expect(getQueuedInputs(CONV).map((item) => item.text)).toEqual(['第二条']);
    expect(screen.getByText('当前回复已停止，队列已暂停')).toBeInTheDocument();
  });

  it('re-pauses the remaining queue when resume fails during startup', async () => {
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
    expect(getQueuedInputs(CONV).map((item) => item.text)).toEqual(['第二条']);
  });
});
