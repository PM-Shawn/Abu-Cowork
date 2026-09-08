// @vitest-environment happy-dom
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { useTeamStore } from '@/stores/teamStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import type { Conversation, SubagentDefinition } from '@/types';

const defs: Record<string, Partial<SubagentDefinition>> = {};
vi.mock('@/core/team/roleIdentity', () => ({
  resolveRoleId: (roleId: string) => (defs[roleId] as SubagentDefinition) ?? null,
}));

import { useConversationTeam } from './useTeamDispatches';
import { useConversationTeamLeader } from './useConversationTeamLeader';

describe('team hooks re-resolve once the agent registry has loaded (retest G1: 队员 · 0 after reopen)', () => {
  beforeEach(() => {
    for (const key of Object.keys(defs)) delete defs[key];
    useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead', 'r-a'], createdAt: 1 }] });
    const conversation: Conversation = { id: 'c1', title: 'x', teamId: 't1', createdAt: 1, updatedAt: 2, status: 'idle', messages: [] };
    useChatStore.setState({ conversations: { c1: conversation } } as never);
    useDiscoveryStore.setState({ agents: [] } as never);
  });

  it('useConversationTeam fills the roster when discovery publishes the agents', () => {
    defs['r-lead'] = { name: '数据分析师', description: 'lead' };
    const { result } = renderHook(() => useConversationTeam('c1'));
    expect(result.current?.members).toEqual([]);
    defs['r-a'] = { name: 'zz取数员', description: 'a' };
    act(() => { useDiscoveryStore.setState({ agents: [{ name: 'zz取数员' }] } as never); });
    expect(result.current?.members.map((m) => m.name)).toEqual(['zz取数员']);
  });

  it('useConversationTeamLeader appears once the leader definition is loaded', () => {
    const { result } = renderHook(() => useConversationTeamLeader('c1'));
    expect(result.current).toBeNull();
    defs['r-lead'] = { name: '数据分析师', description: 'lead' };
    act(() => { useDiscoveryStore.setState({ agents: [{ name: '数据分析师' }] } as never); });
    expect(result.current?.leaderName).toBe('数据分析师');
  });
});
