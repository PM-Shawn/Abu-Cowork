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

  it('continues a team conversation with the original request, as the user\'s own send', async () => {
    useChatStore.setState({ conversations: { c1: conversation({ teamId: 't1' }) } } as never);
    await expect(resumeTeamRunAfterRestart('c1')).resolves.toEqual({ reason: 'completed' });
    expect(runAgentLoopDispatched).toHaveBeenCalledTimes(1);
    const [conversationId, text, options] = runAgentLoopDispatched.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(conversationId).toBe('c1');
    expect(text).toContain('出一版周报');
    expect(text).toContain('不要重做');
    expect(options).toEqual({ initiatedBy: 'user' });
  });

  it('hands the dispatch result back unchanged', async () => {
    useChatStore.setState({ conversations: { c1: conversation({ teamId: 't1' }) } } as never);
    runAgentLoopDispatched.mockResolvedValueOnce({ reason: 'error', error: '模型未配置' } as never);
    await expect(resumeTeamRunAfterRestart('c1')).resolves.toEqual({ reason: 'error', error: '模型未配置' });
  });

  it('starts nothing for a plain, read-only, empty or missing conversation', async () => {
    useChatStore.setState({ conversations: {
      plain: conversation({ id: 'plain' }),
      ro: conversation({ id: 'ro', teamId: 't1', readOnly: true }),
      empty: conversation({ id: 'empty', teamId: 't1', messages: [] }),
      systemOnly: conversation({ id: 'systemOnly', teamId: 't1', messages: [{ id: 's1', role: 'user', content: 'x', timestamp: 1, isSystem: true }] }),
    } } as never);
    for (const id of ['plain', 'ro', 'empty', 'systemOnly', 'missing']) {
      await expect(resumeTeamRunAfterRestart(id)).resolves.toBeNull();
    }
    expect(runAgentLoopDispatched).not.toHaveBeenCalled();
  });
});

// Tester additions (P7): a team run the user steered, closed by an app exit.
describe('resumeTeamRunAfterRestart after a steered run (tester)', () => {
  beforeEach(() => { initLanguage('zh-CN'); vi.clearAllMocks(); });

  const steeredRun = (request: string) => conversation({
    teamId: 't1',
    messages: [
      { id: 'u1', role: 'user', content: request, timestamp: 1, loopId: 'L', runState: 'interrupted', runInterruptCause: 'app_exit' },
      { id: 'a1', role: 'assistant', content: '', timestamp: 2, loopId: 'L', toolCalls: [{ id: 't1', name: 'delegate_to_agent', input: {}, result: '财务同事已开始' }] },
      { id: 'steer-q1', role: 'user', content: '只看第三季度', timestamp: 3, loopId: 'L', steered: true },
    ],
  });

  it('continues with the request and what was steered into it, never with the steered message alone', async () => {
    useChatStore.setState({ conversations: { c1: steeredRun('出一版周报') } } as never);
    await resumeTeamRunAfterRestart('c1');
    const text = runAgentLoopDispatched.mock.calls[0][1] as string;
    expect(text).toContain('出一版周报');
    expect(text).toContain('只看第三季度');
    expect(text.indexOf('出一版周报')).toBeLessThan(text.indexOf('只看第三季度'));
  });

  // Found by the tester: the continuation quotes at most 500 characters of
  // "the request" (MAX_REQUEST_CHARS), and the steered text was appended after
  // the request before the cut, so a long request lost the user's correction
  // and the team resumed the uncorrected task. Each part is cut on its own.
  it('keeps the steered correction when the request itself is long', async () => {
    useChatStore.setState({ conversations: { c1: steeredRun(`请整理以下要求：${'细节'.repeat(260)}`) } } as never);
    await resumeTeamRunAfterRestart('c1');
    const text = runAgentLoopDispatched.mock.calls[0][1] as string;
    expect(text).toContain('只看第三季度');
    // The request is still cut, so the quote stays bounded.
    expect(text).not.toContain('细节'.repeat(260));
  });
});
