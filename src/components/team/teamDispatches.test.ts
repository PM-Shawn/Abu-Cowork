import { describe, it, expect } from 'vitest';
import type { Message } from '@/types';
import type { ExecutionStep, TaskExecution } from '@/types/execution';
import { collectMemberDispatches, summarizeByMember } from './teamDispatches';

function step(over: Partial<ExecutionStep>): ExecutionStep {
  return { id: 's', executionId: 'e', type: 'tool', label: 'x', status: 'completed', toolName: 'read_file', toolInput: {}, source: 'agent', detailBlocks: [], ...over };
}

describe('collectMemberDispatches', () => {
  it('reads live delegate steps (with children) and batch children grouped by task', () => {
    const exec: TaskExecution = {
      id: 'e1', conversationId: 'c1', loopId: 'l1', status: 'running', startTime: 10, plannedSteps: [], planParsed: false,
      steps: [
        step({ id: 'd1', type: 'delegate', toolName: 'delegate_to_agent', toolCallId: 'tc-d', agentName: 'zz取数员', status: 'running', startTime: 11,
          toolInput: { agent_name: 'zz取数员', task: '整理数据' }, childSteps: [step({ id: 'c1', status: 'running' })] }),
        step({ id: 'b1', type: 'delegate', toolName: 'run_agent_batch', toolCallId: 'tc-b', status: 'completed', startTime: 20, childSteps: [
          step({ id: 'c2', batchTask: { index: 0, label: '任务A', agent: 'zz取数员' } }),
          step({ id: 'c3', batchTask: { index: 1, label: '任务B', agent: 'zz撰写员' }, status: 'error' }),
          step({ id: 'c4', batchTask: { index: 1, label: '任务B', agent: 'zz撰写员' } }),
        ] }),
      ],
    } as TaskExecution;
    const result = collectMemberDispatches({ conversationId: 'c1', executions: [exec], messages: [] });
    expect(result.map((d) => [d.agent, d.kind, d.taskIndex, d.status, d.stepCount, d.label])).toEqual([
      ['zz取数员', 'delegate', 0, 'running', 1, '整理数据'],
      ['zz取数员', 'batch', 0, 'completed', 1, '任务A'],
      ['zz撰写员', 'batch', 1, 'error', 2, '任务B'],
    ]);
    expect(result[0].identity).toEqual({ conversationId: 'c1', batchToolCallId: 'tc-d' });
    expect(result[1].identity).toEqual({ conversationId: 'c1', batchToolCallId: 'tc-b' });
  });

  it('falls back to persisted message snapshots and prefers the live copy of the same call', () => {
    const messages: Message[] = [{
      id: 'a1', role: 'assistant', content: '', timestamp: 5,
      executionSteps: [
        { id: 'd1', toolCallId: 'tc-d', type: 'delegate', label: '委派给 zz取数员', status: 'completed', toolName: 'delegate_to_agent', agentName: 'zz取数员',
          childSteps: [{ id: 'c1', type: 'tool', label: 'read', status: 'completed', toolName: 'read_file' }] },
        { id: 'd2', toolCallId: 'tc-old', type: 'delegate', label: '委派给 zz撰写员', status: 'completed', toolName: 'delegate_to_agent', agentName: 'zz撰写员' },
      ],
    }];
    const liveExec = {
      id: 'e1', conversationId: 'c1', loopId: 'l1', status: 'running', startTime: 10, plannedSteps: [], planParsed: false,
      steps: [step({ id: 'd1', type: 'delegate', toolName: 'delegate_to_agent', toolCallId: 'tc-d', agentName: 'zz取数员', status: 'running' })],
    } as TaskExecution;
    const result = collectMemberDispatches({ conversationId: 'c1', executions: [liveExec], messages });
    const byKey = Object.fromEntries(result.map((d) => [d.key, d]));
    expect(byKey['tc-d:0'].live).toBe(true);
    expect(byKey['tc-d:0'].status).toBe('running');
    expect(byKey['tc-old:0']).toMatchObject({ live: false, agent: 'zz撰写员', identity: { conversationId: 'c1', assistantMessageId: 'a1', batchToolCallId: 'tc-old' } });
  });

  it('summarizes per roster member with running > latest > idle', () => {
    const dispatches = collectMemberDispatches({ conversationId: 'c1', executions: [], messages: [{
      id: 'a1', role: 'assistant', content: '', timestamp: 5,
      executionSteps: [
        { id: 'd1', toolCallId: 't1', type: 'delegate', label: 'x', status: 'error', toolName: 'delegate_to_agent', agentName: 'a' },
        { id: 'd2', toolCallId: 't2', type: 'delegate', label: 'y', status: 'completed', toolName: 'delegate_to_agent', agentName: 'a' },
      ],
    }] });
    const summary = summarizeByMember(['a', 'b'], dispatches);
    expect(summary.map((m) => [m.agent, m.status, m.dispatches.length])).toEqual([['a', 'completed', 2], ['b', 'idle', 0]]);
  });
});
