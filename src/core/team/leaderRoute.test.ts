import { describe, it, expect } from 'vitest';
import type { SubagentDefinition } from '@/types';
import type { RouteResult } from '@/core/agent/orchestrator';

import {
  applyTeamLeaderRoute,
  captureTeamExecutionSnapshot,
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
    expect(strict).toContain('re-dispatch ONLY that step/member');
    expect(strict).toContain('Shared inputs first');
    expect(strict).toContain('<workspace>/<member name>/');
    expect(strict).toContain('set `owner` on every step');
    const loose = buildTeamRoleBlock({ teamId: 't', teamName: '数据小队', leader: def('lead'), members: [] });
    expect(loose).toContain('start dispatching right away');
    expect(loose).toContain('no members yet');
    expect(loose).not.toContain('Instructions from the user');
  });

  it('role block hands the last split over as reference input, never as a skip', () => {
    const block = buildTeamRoleBlock({ teamId: 't', teamName: '数据小队', leader: def('lead'), members: [def('a')], lastPlan: { request: '出周报', steps: ['取数 @a', '汇总 @lead'] } });
    expect(block).toContain('Last time this team handled: "出周报"');
    expect(block).toContain('- 取数 @a');
    expect(block).toContain('still call report_plan');
    expect(buildTeamRoleBlock({ teamId: 't', teamName: '数据小队', leader: def('lead'), members: [], lastPlan: { request: 'x', steps: [] } })).not.toContain('Last time');
  });

  it('role block tells the leader that mid-run member instructions are genuine (retest G1)', () => {
    const block = buildTeamRoleBlock({ teamId: 't', teamName: '数据小队', leader: def('lead'), members: [def('a')] });
    expect(block).toContain('14. Mid-run instructions');
    expect(block).toContain('never tell the member to ignore it');
  });

  it('available-agents text lists only members (null when the team has none)', () => {
    const text = buildTeamAvailableAgentsText({ teamId: 't', teamName: 'x', leader: def('lead'), members: [def('a')] }, () => '[tools]');
    expect(text).toContain('- a: a desc [tools]');
    expect(text).not.toContain('lead:');
    expect(text).toContain('ONLY these names');
    expect(buildTeamAvailableAgentsText({ teamId: 't', teamName: 'x', leader: def('lead'), members: [] }, () => '')).toBeNull();
  });
});

describe('team run identity snapshot (F4)', () => {
  it('keeps the original roster and strict mode when the source changes', () => {
    const team = { teamId: 't1', teamName: 't', leader: def('leader'), members: [def('A')], requirePlanApproval: true };
    const snapshot = captureTeamExecutionSnapshot('t1', team);
    team.members.splice(0, 1, def('outsider'));
    team.requirePlanApproval = false;
    expect(snapshot).toEqual({ teamRoster: ['A'], teamRequirePlanApproval: true });
    expect(isTeamRosterMember(snapshot.teamRoster!, 'outsider')).toBe(false);
    expect(() => captureTeamExecutionSnapshot('t1', null)).toThrow();
    expect(() => captureTeamExecutionSnapshot('another-conversation-team', team)).toThrow();
    expect(captureTeamExecutionSnapshot(undefined, null).teamRoster).toBeUndefined();
  });
});
