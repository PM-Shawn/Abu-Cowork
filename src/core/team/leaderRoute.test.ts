import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SubagentDefinition } from '@/types';
import type { RouteResult } from '@/core/agent/orchestrator';

const teamsRef: { teams: Array<Record<string, unknown>> } = { teams: [] };
vi.mock('@/stores/teamStore', () => ({
  useTeamStore: { getState: () => ({ teams: teamsRef.teams }) },
}));
const defs: Record<string, SubagentDefinition> = {};
vi.mock('./roleIdentity', () => ({
  resolveRoleId: (roleId: string) => defs[roleId] ?? null,
}));

import {
  resolveTeamRouteContext,
  applyTeamLeaderRoute,
  teamRosterNames,
  isTeamRosterMember,
  buildTeamRoleBlock,
  buildTeamAvailableAgentsText,
} from './leaderRoute';

function def(name: string, extra: Partial<SubagentDefinition> = {}): SubagentDefinition {
  return { name, description: `${name} desc`, systemPrompt: `${name} prompt`, ...extra } as SubagentDefinition;
}

const general: RouteResult = { type: 'general', name: 'abu', cleanInput: '出周报' };

describe('resolveTeamRouteContext', () => {
  beforeEach(() => {
    teamsRef.teams = [];
    for (const k of Object.keys(defs)) delete defs[k];
    defs['r-lead'] = def('lead', { tools: ['team_propose_plan'] });
    defs['r-a'] = def('a');
    defs['r-b'] = def('b');
  });

  it('returns null without a pin, for archived teams, or when the leader is gone', () => {
    expect(resolveTeamRouteContext(undefined)).toBeNull();
    teamsRef.teams = [{ id: 't1', name: '数据小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead', 'r-a'], archivedAt: 1 }];
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

describe('applyTeamLeaderRoute', () => {
  const team = {
    teamId: 't1', teamName: '数据小队',
    leader: def('lead', { tools: ['team_propose_plan'], disallowedTools: ['run_command'] }),
    members: [def('a'), def('b')],
  };

  it('rewrites a general route into the leader agent route and drops the member-style tools whitelist', () => {
    const r = applyTeamLeaderRoute(general, team);
    expect(r.type).toBe('agent');
    expect(r.name).toBe('lead');
    expect(r.cleanInput).toBe('出周报');
    expect(r.definition?.systemPrompt).toBe('lead prompt');
    expect(r.definition?.tools).toBeUndefined();
    expect(r.definition?.disallowedTools).toEqual(['run_command']);
    expect(r.team).toBe(team);
  });

  it('leaves explicit skill / @agent routes and un-pinned conversations alone', () => {
    const skill: RouteResult = { type: 'skill', name: 's', cleanInput: 'x' };
    const delegate: RouteResult = { type: 'delegate', name: 'a', cleanInput: 'x', delegateAgent: def('a') };
    expect(applyTeamLeaderRoute(skill, team)).toBe(skill);
    expect(applyTeamLeaderRoute(delegate, team)).toBe(delegate);
    expect(applyTeamLeaderRoute(general, null)).toBe(general);
  });
});

describe('roster guard + prompt blocks', () => {
  it('isTeamRosterMember refuses presets (no agent_name) and strangers', () => {
    expect(isTeamRosterMember(['a', 'b'], 'a')).toBe(true);
    expect(isTeamRosterMember(['a', 'b'], 'c')).toBe(false);
    expect(isTeamRosterMember(['a', 'b'], undefined)).toBe(false);
    expect(isTeamRosterMember([], 'a')).toBe(false);
  });

  it('role block carries team name, roster, leader note and the strict-mode rule', () => {
    const strict = buildTeamRoleBlock({ teamId: 't', teamName: '数据小队', leader: def('lead'), members: [def('a')], leaderNote: '先看数据', requirePlanApproval: true });
    expect(strict).toContain('### Team: 数据小队');
    expect(strict).toContain('You are lead, the leader');
    expect(strict).toContain('- a: a desc');
    expect(strict).toContain('先看数据');
    expect(strict).toContain('wait for the user to say');
    expect(strict).toContain('run_agent_batch');
    const loose = buildTeamRoleBlock({ teamId: 't', teamName: '数据小队', leader: def('lead'), members: [] });
    expect(loose).toContain('start dispatching right away');
    expect(loose).toContain('no members yet');
    expect(loose).not.toContain('Instructions from the user');
  });

  it('available-agents text lists only members (null when the team has none)', () => {
    const text = buildTeamAvailableAgentsText({ teamId: 't', teamName: 'x', leader: def('lead'), members: [def('a')] }, () => '[tools]');
    expect(text).toContain('- a: a desc [tools]');
    expect(text).not.toContain('lead:');
    expect(text).toContain('ONLY these names');
    expect(buildTeamAvailableAgentsText({ teamId: 't', teamName: 'x', leader: def('lead'), members: [] }, () => '')).toBeNull();
  });
});
