import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SubagentDefinition } from '@/types';

const teamsRef: { teams: Array<Record<string, unknown>> } = { teams: [] };
vi.mock('@/stores/teamStore', () => ({
  useTeamStore: { getState: () => ({ teams: teamsRef.teams }) },
}));
const defs: Record<string, SubagentDefinition> = {};
vi.mock('./roleIdentity', () => ({
  resolveRoleId: (roleId: string) => defs[roleId] ?? null,
}));

vi.mock('@/stores/discoveryStore', () => {
  const state = { isLoading: false, refresh: vi.fn(async () => { discoveryRefreshed.count += 1; }) };
  return { useDiscoveryStore: { getState: () => state, subscribe: () => () => {} } };
});
vi.mock('@/core/agent/registry', () => ({ agentRegistry: { getAvailableAgents: () => registryAgents.list } }));
const discoveryRefreshed = { count: 0 };
const registryAgents: { list: unknown[] } = { list: [] };

import { resolveTeamRouteContext, resolveTeamRouteContextAsync } from './teamRouteResolver';
import { teamRosterNames } from './leaderRoute';

function def(name: string, extra: Partial<SubagentDefinition> = {}): SubagentDefinition {
  return { name, description: `${name} desc`, systemPrompt: `${name} prompt`, ...extra } as SubagentDefinition;
}

describe('resolveTeamRouteContext', () => {
  beforeEach(() => {
    teamsRef.teams = [];
    for (const k of Object.keys(defs)) delete defs[k];
    defs['r-lead'] = def('lead', { tools: ['team_propose_plan'] });
    defs['r-a'] = def('a');
    defs['r-b'] = def('b');
  });

  it('returns null without a pin, for a deleted team, or when the leader is gone', () => {
    expect(resolveTeamRouteContext(undefined)).toBeNull();
    // Deleted: the pin outlives the team, so the id simply is not there.
    teamsRef.teams = [];
    expect(resolveTeamRouteContext('t1')).toBeNull();
    teamsRef.teams = [{ id: 't1', name: '数据小队', leaderRoleId: 'r-missing', memberRoleIds: ['r-missing', 'r-a'] }];
    expect(resolveTeamRouteContext('t1')).toBeNull();
    expect(resolveTeamRouteContext('nope')).toBeNull();
  });

  it('resolves the roster without the leader and skips unresolvable roles', () => {
    teamsRef.teams = [{ id: 't1', name: '数据小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead', 'r-a', 'r-gone', 'r-b'], leaderNote: '先看数据', requirePlanApproval: true }];
    const ctx = resolveTeamRouteContext('t1');
    expect(ctx).not.toBeNull();
    expect(ctx!.teamName).toBe('数据小队');
    expect(ctx!.leader.name).toBe('lead');
    expect(teamRosterNames(ctx!)).toEqual(['a', 'b']);
    expect(ctx!.leaderNote).toBe('先看数据');
    expect(ctx!.requirePlanApproval).toBe(true);
  });
});

describe('resolveTeamRouteContextAsync', () => {
  it('triggers discovery when the registry is empty and resolves once agents are loaded', async () => {
    teamsRef.teams = [{ id: 't1', name: '数据小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead', 'r-a'] }];
    for (const k of Object.keys(defs)) delete defs[k];
    registryAgents.list = [];
    discoveryRefreshed.count = 0;
    // First pass: nothing resolvable yet; refresh() is the only way to load agents.
    const { useDiscoveryStore } = await import('@/stores/discoveryStore');
    (useDiscoveryStore.getState().refresh as unknown as { mockImplementation: (fn: () => Promise<void>) => void }).mockImplementation(async () => {
      discoveryRefreshed.count += 1;
      defs['r-lead'] = def('lead');
      defs['r-a'] = def('a');
    });
    const ctx = await resolveTeamRouteContextAsync('t1');
    expect(discoveryRefreshed.count).toBe(1);
    expect(ctx?.leader.name).toBe('lead');
  });

  it('rejects a pin whose team was deleted, while an absent pin remains ordinary', async () => {
    discoveryRefreshed.count = 0;
    teamsRef.teams = [];
    expect(await resolveTeamRouteContextAsync(undefined)).toBeNull();
    await expect(resolveTeamRouteContextAsync('t1')).rejects.toThrow();
    expect(discoveryRefreshed.count).toBe(0);
  });
});

describe('unresolvable team pins fail closed (F4)', () => {
  it('rejects missing teams and missing leaders rather than returning an unrestricted route', async () => {
    teamsRef.teams = [];
    await expect(resolveTeamRouteContextAsync('missing')).rejects.toThrow();
    teamsRef.teams = [{ id: 't', name: 'team', leaderRoleId: 'gone', memberRoleIds: ['r-a'] }];
    registryAgents.list = [{}];
    await expect(resolveTeamRouteContextAsync('t')).rejects.toThrow();
  });
});
