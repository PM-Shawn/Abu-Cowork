// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
/**
 * Queued follow-ups render as light-gray pills at the composer's top-right
 * edge, each cancellable. They are not transcript turns until the current
 * task has reached a terminal state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render as renderBare, screen, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps, ReactElement, ReactNode } from 'react';
import { DesignSystemProvider } from '@/components/ds/provider';
import QueuedMessagesStrip from './QueuedMessagesStrip';
import { AgentLoopDispatchError } from '@/core/agent/agentLoopDispatchError';
import type { ImageEditRequest } from '@/types/media';
import {
  enqueueUserInput,
  clearInputQueue,
  getQueuedInputs,
  isSteeringInput,
  pauseUserInputQueue,
  takeSteeringInputsNow,
  beginSteeringRun,
  endSteeringRun,
  isUserInputQueuePaused,
  requeueUserInput,
} from '@/core/agent/userInputQueue';
import { useChatStore } from '@/stores/chatStore';

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
        steerLabel: '下一步加入',
        steerHint: '任务做完当前这一步后会读到这条消息',
        afterRunLabel: '结束后发送',
        sendAfterRun: '任务结束后再发',
        steerLabelTeam: '交给队长',
        steerHintTeam: '队长做完手头这一步后会读到这条消息',
        pausedLabel: '已暂停',
        pausedHint: '点「继续队列」后作为新的一轮发送',
        pausedWhileRunning: '队列已暂停，当前任务结束后可以继续',
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
      expect(runAgentLoopDispatchedMock).toHaveBeenCalledWith(CONV, '第一条', {
        initiatedBy: 'user', queuedHandoff: expect.objectContaining({ text: '第一条' }),
      });
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

  it('resumes an image edit with its captured source and instructions', async () => {
    const request: ImageEditRequest = {
      schemaVersion: 1, id: 'request-1', messageId: 'message-1', scope: 'local', conversationId: CONV,
      sourceArtifactId: 'source-1', sourceCaptureId: 'capture-1', sourceDigest: 'a'.repeat(64), prompt: 'Make it green',
      comments: [], markup: [], region: [],
      attachmentRefs: [{ kind: 'source', fileRef: { originalPath: '/source.png', captureId: 'capture-1', contentDigest: 'a'.repeat(64) }, mimeType: 'image/png', width: 100, height: 100, byteLength: 100 }],
      backendId: 'images', capabilityVersion: '1',
    };
    enqueueUserInput(CONV, request.prompt, false, undefined, undefined, request);
    pauseUserInputQueue(CONV);
    render(<QueuedMessagesStrip conversationId={CONV} />);
    await userEvent.setup().click(screen.getByRole('button', { name: '继续队列' }));
    expect(runAgentLoopDispatchedMock).toHaveBeenCalledWith(CONV, request.prompt, expect.objectContaining({ initiatedBy: 'user', imageEditRequest: request }));
    expect(getQueuedInputs(CONV)).toHaveLength(0);
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
      queuedHandoff: expect.objectContaining({ text: 'selected retry', teamConfirmationRetryId: 'approval-1' }),
    });
  });


  describe('while the task runs (steering)', () => {
    const RUN = 'run-1';
    /** The conversation's status, and the run that reads steering in it (as the run's start and end set it). */
    const setRunning = (running: boolean, extra: { teamId?: string; run?: string } = {}) => {
      useChatStore.setState((state) => ({
        conversations: {
          ...state.conversations,
          [CONV]: {
            id: CONV, title: 't', messages: [], createdAt: 0, updatedAt: 0, status: running ? 'running' : 'idle',
            ...(extra.teamId ? { teamId: extra.teamId } : {}),
          },
        },
      }));
      if (running) beginSteeringRun(CONV, extra.run ?? RUN);
    };
    afterEach(() => {
      useChatStore.setState((state) => {
        const { [CONV]: _gone, ...rest } = state.conversations;
        return { conversations: rest };
      });
    });

    it('marks a plain message as joining the next step, with the send-later action', () => {
      setRunning(true);
      enqueueUserInput(CONV, '改成蓝色');
      render(<QueuedMessagesStrip conversationId={CONV} />);

      const cancel = screen.getByRole('button', { name: '取消排队' });
      const pill = cancel.parentElement!;
      expect(pill).toHaveAttribute('data-delivery', 'steer');
      expect(pill).toHaveTextContent('下一步加入');
      expect(pill).toHaveAttribute('title', '任务做完当前这一步后会读到这条消息');
      expect(screen.getByRole('button', { name: '任务结束后再发' })).toBeInTheDocument();
    });

    it('in a team conversation the pill says the lead reads it, not that it joins the next step', () => {
      setRunning(true, { teamId: 'team-1' });
      enqueueUserInput(CONV, '让财务同事只看第三季度');
      render(<QueuedMessagesStrip conversationId={CONV} />);

      const pill = screen.getByText('让财务同事只看第三季度').parentElement!;
      expect(pill).toHaveAttribute('data-delivery', 'steer');
      expect(pill).toHaveTextContent('交给队长');
      expect(pill).not.toHaveTextContent('下一步加入');
      expect(pill).toHaveAttribute('title', '队长做完手头这一步后会读到这条消息');
    });

    it('"send after the task" turns the pill into one for after the run', async () => {
      const user = userEvent.setup();
      setRunning(true);
      enqueueUserInput(CONV, '改成蓝色');
      render(<QueuedMessagesStrip conversationId={CONV} />);

      await user.click(screen.getByRole('button', { name: '任务结束后再发' }));

      const pill = screen.getByRole('button', { name: '取消排队' }).parentElement!;
      expect(pill).toHaveAttribute('data-delivery', 'after-run');
      expect(pill).toHaveTextContent('结束后发送');
      expect(screen.queryByRole('button', { name: '任务结束后再发' })).not.toBeInTheDocument();
      expect(getQueuedInputs(CONV).some(isSteeringInput)).toBe(false);
      expect(takeSteeringInputsNow(CONV, RUN)).toEqual([]);
    });

    it('a message that names its own route waits for the end of the task', () => {
      setRunning(true);
      enqueueUserInput(CONV, '/ppt 做一份汇报');
      render(<QueuedMessagesStrip conversationId={CONV} />);

      const pill = screen.getByRole('button', { name: '取消排队' }).parentElement!;
      expect(pill).toHaveAttribute('data-delivery', 'after-run');
      expect(pill).toHaveTextContent('结束后发送');
      expect(screen.queryByRole('button', { name: '任务结束后再发' })).not.toBeInTheDocument();
    });

    it('a pill disappears when the task takes it', () => {
      setRunning(true);
      enqueueUserInput(CONV, '改成蓝色');
      render(<QueuedMessagesStrip conversationId={CONV} />);
      expect(screen.getByText('改成蓝色')).toBeInTheDocument();

      act(() => { takeSteeringInputsNow(CONV, RUN); });

      expect(screen.queryByText('改成蓝色')).not.toBeInTheDocument();
    });

    it('a pill the task never took turns into one for after the task when the task ends', () => {
      setRunning(true);
      enqueueUserInput(CONV, '最后再总结三句话');
      render(<QueuedMessagesStrip conversationId={CONV} />);
      expect(screen.getByText('最后再总结三句话').parentElement!).toHaveAttribute('data-delivery', 'steer');

      act(() => { endSteeringRun(CONV, RUN); });

      const pill = screen.getByText('最后再总结三句话').parentElement!;
      expect(pill).toHaveAttribute('data-delivery', 'after-run');
      expect(pill).toHaveTextContent('结束后发送');
    });

    it('outside a running task a steering pill reads as one for after the run', () => {
      setRunning(false);
      beginSteeringRun(CONV, RUN); // the moment the status is already idle and the run not yet settled
      enqueueUserInput(CONV, '改成蓝色');
      render(<QueuedMessagesStrip conversationId={CONV} />);

      expect(screen.getByRole('button', { name: '取消排队' }).parentElement!).toHaveAttribute('data-delivery', 'after-run');
      expect(screen.queryByRole('button', { name: '任务结束后再发' })).not.toBeInTheDocument();
    });

    it('after Stop the pills are paused entries for after the run, and say so', () => {
      setRunning(true);
      enqueueUserInput(CONV, '改成蓝色');
      endSteeringRun(CONV, RUN); // the Stop ends the run's steering ...
      pauseUserInputQueue(CONV); // ... and pauses the queue
      setRunning(false);
      render(<QueuedMessagesStrip conversationId={CONV} />);

      const pill = screen.getByRole('button', { name: '取消排队' }).parentElement!;
      expect(pill).toHaveAttribute('data-delivery', 'after-run');
      expect(pill).toHaveTextContent('已暂停');
      expect(pill).not.toHaveTextContent('结束后发送');
      expect(pill).toHaveAttribute('title', '点「继续队列」后作为新的一轮发送');
      expect(screen.getByText('当前回复已停止，队列已暂停')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '继续队列' })).toBeEnabled();
    });

    // Found by the tester: after a Stop the user starts a new run and types
    // into it. The pill said 「下一步加入」 while the paused queue gave the
    // running task nothing. A pill that says it joins the next step is one the
    // task can take: it is bound to the run it was typed into.
    it('a pill labelled 「下一步加入」 in a run after a Stop is one the task can take', () => {
      enqueueUserInput(CONV, '先别发邮件');
      pauseUserInputQueue(CONV); // Stop on the earlier run
      setRunning(true, { run: 'run-c' }); // the user started a new run
      enqueueUserInput(CONV, '标题改成周报');
      render(<QueuedMessagesStrip conversationId={CONV} />);

      const pill = screen.getByText('标题改成周报').parentElement!;
      expect(pill).toHaveAttribute('data-delivery', 'steer');
      expect(pill).toHaveTextContent('下一步加入');
      // The earlier run's message waits for the resume, and says so.
      expect(screen.getByText('先别发邮件').parentElement!).toHaveTextContent('已暂停');
      let taken: string[] = [];
      act(() => { taken = takeSteeringInputsNow(CONV, 'run-c').map((item) => item.text); });
      expect(taken).toEqual(['标题改成周报']);
    });

    it('「继续队列」 waits while a task runs, says so, and keeps the focus', async () => {
      const user = userEvent.setup();
      enqueueUserInput(CONV, '先别发邮件');
      pauseUserInputQueue(CONV);
      setRunning(true, { run: 'run-c' });
      render(<QueuedMessagesStrip conversationId={CONV} />);

      // The stopped reply is not what is on screen now: the line says when
      // the queue can go on, and is the button's reason.
      expect(screen.queryByText('当前回复已停止，队列已暂停')).not.toBeInTheDocument();
      const resume = screen.getByRole('button', { name: '继续队列' });
      expect(resume).toHaveAccessibleDescription('队列已暂停，当前任务结束后可以继续');
      // Busy, not disabled: it keeps the focus a task started under it.
      expect(resume).not.toBeDisabled();
      expect(resume).toHaveAttribute('aria-disabled', 'true');
      await user.click(resume);
      expect(resume).toHaveFocus();

      expect(runAgentLoopDispatchedMock).not.toHaveBeenCalled();
      expect(getQueuedInputs(CONV).map((item) => item.text)).toEqual(['先别发邮件']);
    });

    it('a resume that meets a task started meanwhile leaves the message waiting for that task, unpaused', async () => {
      const user = userEvent.setup();
      enqueueUserInput(CONV, '先别发邮件');
      pauseUserInputQueue(CONV);
      // The dispatcher found a run already live and put the entry back (requeueUserInput).
      runAgentLoopDispatchedMock.mockImplementationOnce(async (_conv: string, _text: string, options: { queuedHandoff: Parameters<typeof requeueUserInput>[1] }) => {
        requeueUserInput(CONV, options.queuedHandoff);
        return { reason: 'enqueued' };
      });
      render(<QueuedMessagesStrip conversationId={CONV} />);

      await user.click(screen.getByRole('button', { name: '继续队列' }));

      await vi.waitFor(() => expect(runAgentLoopDispatchedMock).toHaveBeenCalledTimes(1));
      expect(getQueuedInputs(CONV).map((item) => item.text)).toEqual(['先别发邮件']);
      expect(isUserInputQueuePaused(CONV)).toBe(false);
    });
  });
});
