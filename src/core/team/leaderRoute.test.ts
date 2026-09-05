import { describe, it, expect } from 'vitest';
import type { SubagentDefinition } from '@/types';
import type { RouteResult } from '@/core/agent/orchestrator';

import {
  applyTeamLeaderRoute,
  isTeamRosterMember,
  buildTeamRoleBlock,
  buildTeamAvailableAgentsText,
} from './leaderRoute';

function def(name: string, extra: Partial<SubagentDefinition> = {}): SubagentDefinition {
  return { name, description: `${name} desc`, systemPrompt: `${name} prompt`, ...extra } as SubagentDefinition;
}

const general: RouteResult = { type: 'general', name: 'abu', cleanInput: '出周报' };

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
    expect(strict).toContain('approve your plan before anything is dispatched');
    expect(strict).toContain('run_agent_batch');
    expect(strict).toContain('set `owner` on every step');
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
