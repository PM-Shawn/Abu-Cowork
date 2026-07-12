/// <reference types="@testing-library/jest-dom" />
/**
 * Regression: the panel used to bind to the conversation's LATEST execution —
 * a follow-up turn without report_plan (or a finished loop) blanked the panel
 * back to the placeholder even though a plan existed one turn earlier. It now
 * keeps showing the most recent execution that actually has planned steps.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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

describe('TaskProgressPanel', () => {
  beforeEach(() => {
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

  // Regression: plannedSteps snapshots are persisted onto chat messages, so a
  // history conversation can carry a pre-narrowing status value ('running')
  // that falls outside the current PlannedStep['status'] union. That used to
  // fall through the icon switch's default branch and render as an empty
  // "not started" circle — losing the fact the step was actually in-flight.
  it('renders a legacy "running" status step as in-progress (spinner), not blank/pending', () => {
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
                // Cast past the narrowed union — this simulates a legacy
                // snapshot value that predates the status narrowing.
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
    render(<TaskProgressPanel />);
    const row = screen.getByText('旧状态步骤').closest('div.flex.items-start');
    expect(row?.querySelector('.animate-spin')).toBeInTheDocument();
  });
});
