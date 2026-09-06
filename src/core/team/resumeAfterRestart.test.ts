import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import type { Conversation } from '@/types';

const runAgentLoopDispatched = vi.fn((..._args: unknown[]) => Promise.resolve({ reason: 'completed' }));
vi.mock('@/core/agent/agentLoopRunner', () => ({ runAgentLoopDispatched: (...args: unknown[]) => runAgentLoopDispatched(...args) }));

import { resumeTeamRunAfterRestart } from './resumeAfterRestart';

function conversation(over: Partial<Conversation>): Conversation {
  return {
    id: 'c1', title: 't', createdAt: 1, updatedAt: 1, status: 'idle',
    messages: [{ id: 'u1', role: 'user', content: '出一版周报', timestamp: 1 }, { id: 'a1', role: 'assistant', content: '好', timestamp: 2 }],
    ...over,
  };
}

describe('resumeTeamRunAfterRestart', () => {
  beforeEach(() => { initLanguage('zh-CN'); vi.clearAllMocks(); });

  it('continues a team conversation with the original request and the interrupted turn', async () => {
    useChatStore.setState({ conversations: { c1: conversation({ teamId: 't1' }) } } as never);
    await expect(resumeTeamRunAfterRestart('c1', 4)).resolves.toBe(true);
    expect(runAgentLoopDispatched).toHaveBeenCalledTimes(1);
    const text = String(runAgentLoopDispatched.mock.calls[0][1]);
    expect(text).toContain('出一版周报');
    expect(text).toContain('4');
    expect(text).toContain('不要重做');
  });

  it('leaves plain, scheduled, trigger, IM and read-only conversations alone', async () => {
    useChatStore.setState({ conversations: {
      plain: conversation({ id: 'plain' }),
      sched: conversation({ id: 'sched', teamId: 't1', scheduledTaskId: 'task' }),
      trig: conversation({ id: 'trig', teamId: 't1', triggerId: 'tr' }),
      im: conversation({ id: 'im', teamId: 't1', imChannelId: 'ch' }),
      ro: conversation({ id: 'ro', teamId: 't1', readOnly: true }),
      empty: conversation({ id: 'empty', teamId: 't1', messages: [] }),
    } } as never);
    for (const id of ['plain', 'sched', 'trig', 'im', 'ro', 'empty', 'missing']) {
      await expect(resumeTeamRunAfterRestart(id, 2)).resolves.toBe(false);
    }
    expect(runAgentLoopDispatched).not.toHaveBeenCalled();
  });
});
