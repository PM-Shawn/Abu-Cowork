// @vitest-environment happy-dom
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { useTeamStore } from '@/stores/teamStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import type { Conversation, SubagentDefinition } from '@/types';

const defs: Record<string, Partial<SubagentDefinition>> = {};
// Reactive stand-in for the plugin store: only `activationReady` matters here.
vi.mock('@/stores/pluginStore', async () => {
  const { create } = await import('zustand');
  return { usePluginStore: create(() => ({ activationReady: true })) };
});
vi.mock('@/core/team/roleIdentity', async () => {
  const { usePluginStore } = await import('@/stores/pluginStore');
  return {
    // Mirrors activationPolicy: until plugin records are ready, a file-backed
    // agent (any filePath not starting with `__`) does not resolve.
    resolveRoleId: (roleId: string) => {
      const def = defs[roleId] as SubagentDefinition | undefined;
      if (!def) return null;
      const fileBacked = !!def.filePath && !def.filePath.startsWith('__');
      return fileBacked && !usePluginStore.getState().activationReady ? null : def;
    },
  };
});

import { usePluginStore } from '@/stores/pluginStore';
import { useConversationTeam } from './useTeamDispatches';
import { useConversationTeamLeader } from './useConversationTeamLeader';

describe('team hooks re-resolve once the agent registry has loaded (retest G1: 队员 · 0 after reopen)', () => {
  beforeEach(() => {
    for (const key of Object.keys(defs)) delete defs[key];
    useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead', 'r-a'], createdAt: 1 }] });
    const conversation: Conversation = { id: 'c1', title: 'x', teamId: 't1', createdAt: 1, updatedAt: 2, status: 'idle', messages: [] };
    useChatStore.setState({ conversations: { c1: conversation } } as never);
    useDiscoveryStore.setState({ agents: [] } as never);
    usePluginStore.setState({ activationReady: true });
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

  // P1: at launch discovery publishes BEFORE the first installed.json read, and
  // until that read the registry hides every file-backed agent. Readiness is the
  // only thing that changes then, so the hooks must depend on it.
  it('useConversationTeam re-resolves a user expert when plugin records become ready (no discovery change)', () => {
    usePluginStore.setState({ activationReady: false });
    defs['r-lead'] = { name: '数据分析师', description: 'lead', filePath: '__builtin__' };
    defs['r-a'] = { name: 'zz取数员', description: 'a', filePath: '/Users/tester/.abu/agents/zz取数员/AGENT.md' };
    const { result } = renderHook(() => useConversationTeam('c1'));
    expect(result.current?.members).toEqual([]);
    expect(result.current?.unresolvedMemberRoleIds).toEqual(['r-a']);

    act(() => { usePluginStore.setState({ activationReady: true }); });

    expect(result.current?.members.map((m) => m.name)).toEqual(['zz取数员']);
    expect(result.current?.unresolvedMemberRoleIds).toEqual([]);
  });

  it('useConversationTeamLeader appears when plugin records become ready for a user-expert leader', () => {
    usePluginStore.setState({ activationReady: false });
    defs['r-lead'] = { name: 'zz队长', description: 'lead', filePath: '/Users/tester/.abu/agents/zz队长/AGENT.md' };
    const { result } = renderHook(() => useConversationTeamLeader('c1'));
    expect(result.current).toBeNull();

    act(() => { usePluginStore.setState({ activationReady: true }); });

    expect(result.current?.leaderName).toBe('zz队长');
  });
});
