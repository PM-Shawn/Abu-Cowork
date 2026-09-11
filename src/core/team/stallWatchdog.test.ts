import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useTaskExecutionStore } from '@/stores/taskExecutionStore';
import type { Conversation } from '@/types';
import type { ExecutionStep, TaskExecution } from '@/types/execution';

const requestDispatchCancel = vi.fn();
vi.mock('@/core/agent/dispatchCancel', () => ({ requestDispatchCancel: (...args: unknown[]) => requestDispatchCancel(...args) }));
const notifyTeamStallStopped = vi.fn();
vi.mock('@/utils/notifications', () => ({ notifyTeamStallStopped: (...args: unknown[]) => notifyTeamStallStopped(...args) }));

import { findStalledDispatches, runStallCheck, STALL_STOP_MINUTES, stopTeamStallWatchdog } from './stallWatchdog';

const MIN = 60_000;
function step(over: Partial<ExecutionStep>): ExecutionStep {
  return { id: 's', executionId: 'e', type: 'tool', label: 'x', status: 'completed', toolName: 'read_file', toolInput: {}, source: 'agent', detailBlocks: [], ...over };
}
function execution(conversationId: string, startTime: number, children: ExecutionStep[]): TaskExecution {
  return {
    id: `e-${conversationId}`, conversationId, loopId: `l-${conversationId}`, status: 'running', startTime, plannedSteps: [], planParsed: false,
    steps: [step({ id: `d-${conversationId}`, type: 'delegate', toolName: 'delegate_to_agent', toolCallId: `tc-${conversationId}`, agentName: 'zz取数员', status: 'running', startTime, childSteps: children })],
  } as TaskExecution;
}
function conversation(id: string, teamId?: string): Conversation {
  return { id, title: id, ...(teamId ? { teamId } : {}), createdAt: 1, updatedAt: 1, status: 'running', messages: [] };
}

describe('team stall watchdog (lease expiry, one hand-off at a time)', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    stopTeamStallWatchdog();
    vi.clearAllMocks();
    useChatStore.setState({ conversations: { team: conversation('team', 't1'), plain: conversation('plain') }, agentStates: new Map() } as never);
  });
  afterEach(() => stopTeamStallWatchdog());

  it('reports only team hand-offs whose last step is older than the threshold', () => {
    const now = 100 * MIN;
    const old = now - (STALL_STOP_MINUTES + 2) * MIN;
    useTaskExecutionStore.setState({ executions: {
      team: execution('team', old, [step({ id: 'c1', status: 'running', startTime: old })]),
      plain: execution('plain', old, []),
    } } as never);
    expect(findStalledDispatches(now)).toEqual([{ conversationId: 'team', key: 'tc-team:0', agent: 'zz取数员', minutes: STALL_STOP_MINUTES + 2 }]);

    // A fresh step renews the lease.
    useTaskExecutionStore.setState({ executions: {
      team: execution('team', old, [step({ id: 'c1', status: 'completed', startTime: old, endTime: now - MIN })]),
    } } as never);
    expect(findStalledDispatches(now)).toEqual([]);
  });

  it('stops a stalled hand-off once, with a reason the leader can read, and notifies', () => {
    const now = 100 * MIN;
    const old = now - STALL_STOP_MINUTES * MIN;
    useTaskExecutionStore.setState({ executions: { team: execution('team', old, []) } } as never);
    expect(runStallCheck(now)).toBe(1);
    expect(requestDispatchCancel).toHaveBeenCalledTimes(1);
    expect(requestDispatchCancel.mock.calls[0][0]).toBe('tc-team:0');
    expect(String(requestDispatchCancel.mock.calls[0][1])).toContain(String(STALL_STOP_MINUTES));
    expect(notifyTeamStallStopped).toHaveBeenCalledWith(expect.stringContaining('zz取数员'), 'team');
    // Still reported as running a moment later → not stopped again.
    expect(runStallCheck(now + MIN)).toBe(0);
    expect(requestDispatchCancel).toHaveBeenCalledTimes(1);
  });
});
