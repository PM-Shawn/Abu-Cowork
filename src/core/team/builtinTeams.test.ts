import { describe, expect, it } from 'vitest';
import { BUILTIN_TEAMS, BUILTIN_TEAM_ID_PREFIX, isBuiltinTeam } from './builtinTeams';
import { BUILTIN_AGENT_NAMES } from '../../../electron/shared/pluginAgentFormat.mjs';

/**
 * The shipped 专家团 shelf. Ids and member names are release-frozen
 * identifiers: a rename breaks every conversation and schedule pinned to the
 * team, and a member name that no shipped expert answers to resolves to
 * nothing at run time (the roster silently shrinks). Both are pinned here.
 */
describe('builtinTeams', () => {
  it('every id carries the prefix and is unique', () => {
    const ids = BUILTIN_TEAMS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const team of BUILTIN_TEAMS) expect(isBuiltinTeam(team)).toBe(true);
    expect(isBuiltinTeam({ id: 'team-abc' })).toBe(false);
    expect(BUILTIN_TEAM_ID_PREFIX).toBe('builtin-team:');
  });

  it('leader is a member and every member is a shipped built-in expert', () => {
    const shipped = new Set(BUILTIN_AGENT_NAMES as readonly string[]);
    for (const team of BUILTIN_TEAMS) {
      expect(team.memberRoleIds).toContain(team.leaderRoleId);
      for (const roleId of team.memberRoleIds) {
        expect(roleId.startsWith('builtin:')).toBe(true);
        expect(shipped.has(roleId.slice('builtin:'.length))).toBe(true);
      }
    }
  });

  it('names are unique, so a user team can never collide with two of them', () => {
    const names = BUILTIN_TEAMS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('ships four teams with copy filled in', () => {
    expect(BUILTIN_TEAMS).toHaveLength(4);
    for (const team of BUILTIN_TEAMS) {
      expect(team.description).toBeTruthy();
      expect(team.intro).toBeTruthy();
      expect(team.samplePrompts?.length).toBeGreaterThanOrEqual(3);
      expect(team.leaderNote).toBeTruthy();
    }
  });
});
