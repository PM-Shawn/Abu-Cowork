import { describe, it, expect, beforeEach } from 'vitest';
import { BUILTIN_TEAMS, isBuiltinTeam } from '@/core/team/builtinTeams';
import { mergeTeamState, migrateTeamState, partializeTeamState, useTeamStore } from './teamStore';
import type { Team } from './teamStore';

function reset() {
  useTeamStore.setState({ teams: []});
}

describe('teamStore', () => {
  beforeEach(reset);

  describe('createTeam', () => {
    it('creates a team and always includes the leader as a member', () => {
      const team = useTeamStore.getState().createTeam({
        name: '数据小队',
        leaderRoleId: 'role-a',
        memberRoleIds: ['role-b'],
      });
      expect(team.memberRoleIds).toContain('role-a');
      expect(team.memberRoleIds).toContain('role-b');
      expect(useTeamStore.getState().teams).toHaveLength(1);
    });

    it('dedupes the leader when passed in both fields', () => {
      const team = useTeamStore.getState().createTeam({
        name: 't', leaderRoleId: 'role-a', memberRoleIds: ['role-a', 'role-b'],
      });
      expect(team.memberRoleIds.filter((id) => id === 'role-a')).toHaveLength(1);
    });

    it('rejects empty name, missing leader, and duplicate active names', () => {
      const s = useTeamStore.getState();
      expect(() => s.createTeam({ name: '  ', leaderRoleId: 'r', memberRoleIds: [] })).toThrow();
      expect(() => s.createTeam({ name: 't', leaderRoleId: '', memberRoleIds: [] })).toThrow();
      s.createTeam({ name: 't', leaderRoleId: 'r', memberRoleIds: [] });
      expect(() => useTeamStore.getState().createTeam({ name: 't', leaderRoleId: 'r2', memberRoleIds: [] })).toThrow();
    });

    it('frees the name once the team is deleted', () => {
      const team = useTeamStore.getState().createTeam({ name: 't', leaderRoleId: 'r', memberRoleIds: [] });
      expect(() => useTeamStore.getState().createTeam({ name: 't', leaderRoleId: 'r', memberRoleIds: [] })).toThrow();
      useTeamStore.getState().deleteTeam(team.id);
      expect(() => useTeamStore.getState().createTeam({ name: 't', leaderRoleId: 'r', memberRoleIds: [] })).not.toThrow();
    });
  });

  describe('updateTeam', () => {
    it('re-adds the new leader to members when leadership changes', () => {
      const team = useTeamStore.getState().createTeam({ name: 't', leaderRoleId: 'role-a', memberRoleIds: ['role-b'] });
      useTeamStore.getState().updateTeam(team.id, { leaderRoleId: 'role-c', memberRoleIds: ['role-b'] });
      const updated = useTeamStore.getState().teams[0];
      expect(updated.leaderRoleId).toBe('role-c');
      expect(updated.memberRoleIds).toContain('role-c');
    });
  });

  describe('deleteTeam', () => {
    it('removes only that team, leaving the rest alone', () => {
      const a = useTeamStore.getState().createTeam({ name: 'a', leaderRoleId: 'r', memberRoleIds: [] });
      useTeamStore.getState().createTeam({ name: 'b', leaderRoleId: 'r', memberRoleIds: [] });
      useTeamStore.getState().deleteTeam(a.id);
      expect(useTeamStore.getState().teams.map((t) => t.name)).toEqual(['b']);
    });

    /**
     * v6 → v7 dropped archive. A team the user had archived comes BACK to the
     * list instead of vanishing: they asked to archive it, never to erase it,
     * and an upgrade must not delete their data on its own.
     */
    it('migration keeps previously archived teams, minus the field', () => {
      const out = migrateTeamState({ teams: [{ id: '1', name: 'old', leaderRoleId: 'r', memberRoleIds: [], createdAt: 1, archivedAt: 99 }] }) as unknown as { teams: Array<Record<string, unknown>> };
      expect(out.teams).toHaveLength(1);
      expect(out.teams[0].name).toBe('old');
      expect('archivedAt' in out.teams[0]).toBe(false);
    });
  });

  describe('display fields', () => {
    it('creates and updates all optional display fields', () => {
      const display = { description: 'Data team', intro: 'We gather and chart data', expertise: ['Queries', 'Charts'], samplePrompts: ['Review last quarter'] };
      const team = useTeamStore.getState().createTeam({ name: 't', leaderRoleId: 'r', memberRoleIds: [], ...display });
      expect(team).toMatchObject(display);
      const updated = { description: 'Research team', intro: 'We investigate', expertise: ['Research'], samplePrompts: ['Investigate this'] };
      useTeamStore.getState().updateTeam(team.id, updated);
      expect(useTeamStore.getState().teams[0]).toMatchObject(updated);
    });

    it('keeps empty display fields optional', () => {
      const team = useTeamStore.getState().createTeam({ name: 't', leaderRoleId: 'r', memberRoleIds: [], description: '', intro: '', expertise: [], samplePrompts: [] });
      expect(team.description).toBeUndefined();
      expect(team.intro).toBeUndefined();
      expect(team.expertise).toBeUndefined();
      expect(team.samplePrompts).toBeUndefined();
    });

    it('preserves every v7 team field without inventing display content', () => {
      const team = { id: '1', name: 'old', leaderRoleId: 'r', memberRoleIds: ['r'], createdAt: 1, avatar: '📊', leaderNote: 'Check sources', requirePlanApproval: true, lastPlan: { request: 'Review', steps: ['Read'], savedAt: 2 } };
      const out = migrateTeamState({ teams: [team] });
      expect(out.teams).toEqual([team]);
      expect(out.teams[0].description).toBeUndefined();
    });
  });
  describe('built-in teams', () => {
    it('are present after a reset to the initial state and never written to disk', () => {
      useTeamStore.setState({ teams: [...BUILTIN_TEAMS] });
      const persisted = partializeTeamState(useTeamStore.getState());
      expect(persisted.teams).toHaveLength(0);
      expect(useTeamStore.getState().teams.filter(isBuiltinTeam)).toHaveLength(BUILTIN_TEAMS.length);
    });

    it('come back from the shipped roster on hydration, not from the persisted blob', () => {
      // A blob written by an older version carries a built-in copy (and may be
      // missing one this version added). Hydration must hand back TODAY's
      // roster plus the user's own teams — otherwise a renamed or retired
      // built-in would live on in everyone's data directory.
      const stale: Team = { ...BUILTIN_TEAMS[0], name: '旧名字', memberRoleIds: [] };
      const mine: Team = { id: 'team-mine', name: '我的小队', leaderRoleId: 'role-a', memberRoleIds: ['role-a'], createdAt: 1 };
      const merged = mergeTeamState({ teams: [mine, stale] }, useTeamStore.getState());
      // Order matters too: the user's teams first, then today's roster.
      expect(merged.teams).toEqual([mine, ...BUILTIN_TEAMS]);
      expect(merged.teams.some((t) => t.name === '旧名字')).toBe(false);
    });

    it('cannot be deleted or edited except for lastPlan', () => {
      useTeamStore.setState({ teams: [...BUILTIN_TEAMS] });
      const target = BUILTIN_TEAMS[0];
      useTeamStore.getState().deleteTeam(target.id);
      expect(useTeamStore.getState().teams.find((t) => t.id === target.id)).toBeDefined();
      useTeamStore.getState().updateTeam(target.id, { name: '改名', lastPlan: { request: 'r', steps: ['s'], savedAt: 1 } });
      const after = useTeamStore.getState().teams.find((t) => t.id === target.id)!;
      expect(after.name).toBe(target.name);
      expect(after.lastPlan?.steps).toEqual(['s']);
    });

    it('rejects a user team named like a built-in one', () => {
      useTeamStore.setState({ teams: [...BUILTIN_TEAMS] });
      expect(() => useTeamStore.getState().createTeam({ name: BUILTIN_TEAMS[0].name, leaderRoleId: 'role-a', memberRoleIds: [] })).toThrow('duplicate team name');
    });
  });
});
