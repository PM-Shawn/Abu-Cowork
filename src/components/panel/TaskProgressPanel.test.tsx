// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
/**
 * Regression: the panel used to bind to the conversation's LATEST execution —
 * a follow-up turn without report_plan (or a finished loop) blanked the panel
 * back to the placeholder even though a plan existed one turn earlier. It now
 * keeps showing the most recent execution that actually has planned steps.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { initLanguage } from '@/i18n';
import TaskProgressPanel from './TaskProgressPanel';
import { useChatStore } from '@/stores/chatStore';
import { useTaskExecutionStore } from '@/stores/taskExecutionStore';
import type { TaskExecution } from '@/types/execution';

function makeExec(id: string, startTime: number, stepDescs: string[]): TaskExecution {
  return {
    id,
    conversationId: 'conv-1',
    loopId: `loop-${id}`,
    status: 'completed',
    startTime,
    plannedSteps: stepDescs.map((description, i) => ({
      index: i + 1,
      description,
      status: 'completed' as const,
    })),
    planParsed: stepDescs.length > 0,
    steps: [],
  } as TaskExecution;
}

afterEach(() => cleanup());

function titleButton() {
  return screen.getByRole('button', { name: /Progress/ });
}

describe('TaskProgressPanel', () => {
  beforeEach(() => {
    initLanguage('en-US');
    useChatStore.setState({ activeConversationId: 'conv-1' });
    useTaskExecutionStore.setState({ executions: {} });
  });

  it('keeps showing the most recent execution WITH planned steps', () => {
    useTaskExecutionStore.setState({
      executions: {
        e1: makeExec('e1', 100, ['扫描目录', '删除日志']),
        e2: makeExec('e2', 200, []), // newer turn without a plan
      },
    });
    render(<TaskProgressPanel />);
    expect(screen.getByText('扫描目录')).toBeInTheDocument();
    expect(screen.getByText('删除日志')).toBeInTheDocument();
  });

  it('prefers the newest plan when several executions have one', () => {
    useTaskExecutionStore.setState({
      executions: {
        e1: makeExec('e1', 100, ['旧计划步骤']),
        e2: makeExec('e2', 200, ['新计划步骤']),
      },
    });
    render(<TaskProgressPanel />);
    expect(screen.getByText('新计划步骤')).toBeInTheDocument();
    expect(screen.queryByText('旧计划步骤')).not.toBeInTheDocument();
  });

  it('shows the placeholder when no execution ever had a plan', () => {
    useTaskExecutionStore.setState({
      executions: { e1: makeExec('e1', 100, []) },
    });
    render(<TaskProgressPanel />);
    expect(screen.queryByText('扫描目录')).not.toBeInTheDocument();
  });

  // Regression: persistExecutionSnapshot evicts the execution when the loop
  // ends, destroying plannedSteps with it — the panel collapsed back to the
  // placeholder after every finished loop. It must fall back to the snapshot
  // persisted on the loop's last assistant message.
  it('falls back to plannedSteps persisted on conversation messages after eviction', () => {
    useTaskExecutionStore.setState({ executions: {} });
    useChatStore.setState({
      activeConversationId: 'conv-1',
      conversations: {
        'conv-1': {
          id: 'conv-1',
          title: '测试任务',
          messages: [
            {
              id: 'm1',
              role: 'assistant' as const,
              content: '计划完成',
              timestamp: 100,
              loopId: 'loop-1',
              plannedSteps: [
                { index: 1, description: '已持久化步骤A', status: 'completed' as const },
                { index: 2, description: '已持久化步骤B', status: 'completed' as const },
              ],
            },
          ],
          createdAt: 100,
          updatedAt: 100,
          status: 'completed' as const,
        },
      },
    });
    render(<TaskProgressPanel />);
    expect(screen.getByText('已持久化步骤A')).toBeInTheDocument();
    expect(screen.getByText('已持久化步骤B')).toBeInTheDocument();
  });

  // While a running execution owns the plan, the progress area shows exactly one
  // spinner, on the title row. The step being worked on is marked as the current
  // step and stays still.
  it('shows one spinner on the title row while the execution is live', () => {
    useTaskExecutionStore.setState({
      executions: {
        e1: {
          id: 'e1',
          conversationId: 'conv-1',
          loopId: 'loop-e1',
          status: 'running',
          startTime: 100,
          plannedSteps: [{ index: 1, description: '进行中步骤', status: 'in_progress' as const }],
          planParsed: true,
          steps: [],
        } as TaskExecution,
      },
    });
    const { container } = render(<TaskProgressPanel />);
    const spinners = container.querySelectorAll('[data-ds-spinner]');
    expect(spinners).toHaveLength(1);
    expect(titleButton()).toContainElement(spinners[0] as HTMLElement);
    const step = screen.getByText('进行中步骤').closest('li');
    expect(step).toHaveAttribute('aria-current', 'step');
    expect(step?.querySelector('[data-ds-spinner]')).not.toBeInTheDocument();
  });

  // Smoke-test bug: on abort the loop cancels the execution but RETURNS before
  // persistExecutionSnapshot evicts it, so a cancelled execution lingers in the
  // store with an in_progress step. Presence of plannedSteps is not enough to
  // mean "live" — gate on status 'running'. A lingering cancelled plan shows no
  // spinner anywhere; its step keeps the current-step marker.
  it('shows no spinner for a stopped (lingering) execution', () => {
    useTaskExecutionStore.setState({
      executions: {
        e1: {
          id: 'e1',
          conversationId: 'conv-1',
          loopId: 'loop-e1',
          status: 'cancelled',
          startTime: 100,
          endTime: 200,
          plannedSteps: [{ index: 1, description: '被停止的步骤', status: 'in_progress' as const }],
          planParsed: true,
          steps: [],
        } as TaskExecution,
      },
    });
    const { container } = render(<TaskProgressPanel />);
    expect(container.querySelector('[data-ds-spinner]')).not.toBeInTheDocument();
    expect(screen.getByText('被停止的步骤').closest('li')).toHaveAttribute('aria-current', 'step');
  });

  // Regression (smoke-test finding): after a task is stopped, the live
  // execution is evicted and the panel falls back to the persisted message
  // snapshot. An in_progress step there must render STATICALLY — no perpetual
  // spinner. Also covers a legacy 'running' snapshot value that predates the
  // status narrowing (it normalizes to in_progress, still static when stopped).
  it('renders a stopped/persisted in-progress step statically (no perpetual spinner)', () => {
    useTaskExecutionStore.setState({ executions: {} });
    useChatStore.setState({
      activeConversationId: 'conv-1',
      conversations: {
        'conv-1': {
          id: 'conv-1',
          title: '测试任务',
          messages: [
            {
              id: 'm1',
              role: 'assistant' as const,
              content: '进行中',
              timestamp: 100,
              loopId: 'loop-1',
              plannedSteps: [
                // Cast past the narrowed union — simulates a legacy snapshot
                // value that predates the status narrowing.
                { index: 1, description: '旧状态步骤', status: 'running' as unknown as 'in_progress' },
              ],
            },
          ],
          createdAt: 100,
          updatedAt: 100,
          status: 'completed' as const,
        },
      },
    });
    const { container } = render(<TaskProgressPanel />);
    expect(container.querySelector('[data-ds-spinner]')).not.toBeInTheDocument();
    expect(screen.getByText('旧状态步骤').closest('li')).toHaveAttribute('aria-current', 'step');
  });

  it('collapses from the title button and says so with aria-expanded', () => {
    useTaskExecutionStore.setState({
      executions: { e1: makeExec('e1', 100, ['扫描目录']) },
    });
    render(<TaskProgressPanel />);
    expect(titleButton()).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(titleButton());
    expect(titleButton()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('扫描目录')).not.toBeInTheDocument();
  });

  it('keeps the owner of a step next to its text', () => {
    useTaskExecutionStore.setState({
      executions: {
        e1: {
          ...makeExec('e1', 100, []),
          plannedSteps: [{ index: 1, description: '整理需求', status: 'pending' as const, owner: '产品经理' }],
        } as TaskExecution,
      },
    });
    render(<TaskProgressPanel />);
    expect(screen.getByTestId('plan-step-owner')).toHaveTextContent('@产品经理');
    expect(screen.getByText('整理需求').closest('li')).toContainElement(screen.getByTestId('plan-step-owner'));
  });

  // History can carry a step status from before the union was narrowed; a failed
  // step keeps its failure mark, and only the step in flight is the current one.
  it('marks each step by its status, including a legacy failed one', () => {
    useTaskExecutionStore.setState({
      executions: {
        e1: {
          ...makeExec('e1', 100, []),
          plannedSteps: [
            { index: 1, description: '已完成步骤', status: 'completed' as const },
            { index: 2, description: '失败步骤', status: 'error' as unknown as 'pending' },
            { index: 3, description: '未开始步骤', status: 'pending' as const },
          ],
        } as TaskExecution,
      },
    });
    render(<TaskProgressPanel />);
    expect(screen.getByRole('list', { name: 'Progress' })).toBeInTheDocument();
    expect(screen.getByText('已完成步骤').closest('li')?.querySelector('svg')).toHaveClass('text-success');
    expect(screen.getByText('失败步骤').closest('li')?.querySelector('svg')).toHaveClass('text-danger');
    expect(screen.getByText('未开始步骤').closest('li')?.querySelector('svg')).not.toBeInTheDocument();
    expect(screen.getByText('未开始步骤').closest('li')).not.toHaveAttribute('aria-current');
  });
});
