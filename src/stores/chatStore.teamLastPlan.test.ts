import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from './chatStore';
import { useTeamStore } from './teamStore';
import type { Conversation } from '@/types';

describe('chatStore.setPlannedStepsSnapshot → team lastPlan (block S)', () => {
  beforeEach(() => {
    useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'r1', memberRoleIds: ['r1', 'r2'], createdAt: 1 }] });
    const conversation: Conversation = {
      id: 'c1', title: 't', teamId: 't1', createdAt: 1, updatedAt: 1, status: 'running',
      messages: [
        { id: 'u1', role: 'user', content: '  出一版本周周报  ', timestamp: 1 },
        { id: 'a1', role: 'assistant', content: '', timestamp: 2, loopId: 'loop-1' },
      ],
    };
    useChatStore.setState({ conversations: { c1: conversation, plain: { ...conversation, id: 'plain', teamId: undefined } } } as never);
  });

  it('stores the request and the owner-tagged steps on the team', async () => {
    useChatStore.getState().setPlannedStepsSnapshot('c1', 'loop-1', [
      { index: 1, description: '取数', status: 'pending', owner: 'zz取数员' },
      { index: 2, description: '汇总', status: 'pending' },
    ]);
    await new Promise((r) => setTimeout(r, 0));
    const team = useTeamStore.getState().teams[0];
    expect(team.lastPlan?.request).toBe('出一版本周周报');
    expect(team.lastPlan?.steps).toEqual(['取数 @zz取数员', '汇总']);
  });

  it('ignores empty plans and conversations without a team', async () => {
    useChatStore.getState().setPlannedStepsSnapshot('c1', 'loop-1', []);
    useChatStore.getState().setPlannedStepsSnapshot('plain', 'loop-1', [{ index: 1, description: 'x', status: 'pending' }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(useTeamStore.getState().teams[0].lastPlan).toBeUndefined();
  });
});
