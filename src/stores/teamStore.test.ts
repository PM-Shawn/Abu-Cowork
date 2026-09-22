import { describe, it, expect, beforeEach } from 'vitest';
import { BUILTIN_TEAMS, isBuiltinTeam } from '@/core/team/builtinTeams';
import { getVisibleTeamById, getVisibleTeams, mergeTeamState, migrateTeamState, partializeTeamState, useTeamStore } from './teamStore';
import type { Team } from './teamStore';

// Looked up by id, not by position: the shelf order is product copy, not a contract.
const SOFTWARE_RD_TEAM = BUILTIN_TEAMS.find((team) => team.id === 'builtin-team:software-rd')!;

function reset() {
  useTeamStore.setState({ teams: [], managedTeamSources: {} });
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

    it('refuses a rename onto a name another team already has', () => {
      const first = useTeamStore.getState().createTeam({ name: '数据小队', leaderRoleId: 'role-a', memberRoleIds: [] });
      const second = useTeamStore.getState().createTeam({ name: '增长小队', leaderRoleId: 'role-b', memberRoleIds: [] });
      expect(() => useTeamStore.getState().updateTeam(second.id, { name: '数据小队' })).toThrow('duplicate team name');
      // The refusal is total: no half-applied patch behind the thrown error.
      const after = useTeamStore.getState().teams.find((t) => t.id === second.id)!;
      expect(after.name).toBe('增长小队');
      expect(useTeamStore.getState().teams.find((t) => t.id === first.id)!.name).toBe('数据小队');
    });

    it('refuses a rename onto a built-in team name', () => {
      useTeamStore.setState({ teams: [...BUILTIN_TEAMS] });
      const mine = useTeamStore.getState().createTeam({ name: '我的小队', leaderRoleId: 'role-a', memberRoleIds: [] });
      // User teams are listed before built-ins, so a collision here would also
      // slip past `save_team`'s built-in read-only guard, which looks up by name.
      expect(() => useTeamStore.getState().updateTeam(mine.id, { name: SOFTWARE_RD_TEAM.name })).toThrow('duplicate team name');
    });

    it('lets a team keep its own name while other fields change', () => {
      const team = useTeamStore.getState().createTeam({ name: '数据小队', leaderRoleId: 'role-a', memberRoleIds: [] });
      useTeamStore.getState().updateTeam(team.id, { name: '数据小队', leaderNote: '先对齐口径' });
      expect(useTeamStore.getState().teams[0].leaderNote).toBe('先对齐口径');
    });

    it('refuses a name that is only whitespace', () => {
      const team = useTeamStore.getState().createTeam({ name: '数据小队', leaderRoleId: 'role-a', memberRoleIds: [] });
      expect(() => useTeamStore.getState().updateTeam(team.id, { name: '   ' })).toThrow('team name required');
      expect(useTeamStore.getState().teams[0].name).toBe('数据小队');
    });

    it('stores the trimmed name the guard checked', () => {
      const team = useTeamStore.getState().createTeam({ name: '数据小队', leaderRoleId: 'role-a', memberRoleIds: [] });
      useTeamStore.getState().updateTeam(team.id, { name: '增长小队 ' });
      expect(useTeamStore.getState().teams[0].name).toBe('增长小队');
    });

    it('leaves patches that carry no name alone', () => {
      useTeamStore.getState().createTeam({ name: '数据小队', leaderRoleId: 'role-a', memberRoleIds: [] });
      const second = useTeamStore.getState().createTeam({ name: '增长小队', leaderRoleId: 'role-b', memberRoleIds: [] });
      useTeamStore.getState().updateTeam(second.id, { lastPlan: { request: 'r', steps: ['s'], savedAt: 1 } });
      expect(useTeamStore.getState().teams.find((t) => t.id === second.id)!.lastPlan?.steps).toEqual(['s']);
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
  describe('managed teams', () => {
    const managed: Team = {
      id: 'managed-team-1', name: '组织审阅团队', leaderRoleId: 'enterprise-agent:1',
      memberRoleIds: ['enterprise-agent:1'], createdAt: 1,
      managed: { source: 'enterprise', id: 'managed-team-1', version: '1', readOnly: true, ready: true },
    };

    it('keeps an active source in memory without persisting it', () => {
      let active = true;
      useTeamStore.getState().registerManagedTeamSource('enterprise', () => active);
      useTeamStore.getState().replaceManagedTeams('enterprise', [managed]);
      expect(getVisibleTeamById(managed.id)).toEqual(managed);
      expect(partializeTeamState(useTeamStore.getState()).teams).toEqual([]);
      active = false;
      expect(getVisibleTeams()).toEqual([]);
    });

    it('shows a managed update alongside its same-name built-in team and resolves the managed one first', () => {
      const builtin = BUILTIN_TEAMS[0];
      const updated = { ...managed, name: builtin.name };
      useTeamStore.setState({ teams: [...BUILTIN_TEAMS] });
      useTeamStore.getState().registerManagedTeamSource('enterprise', () => true);
      useTeamStore.getState().replaceManagedTeams('enterprise', [updated]);

      const matches = getVisibleTeams().filter(team => team.name === builtin.name);
      expect(matches.map(team => team.id)).toEqual([updated.id, builtin.id]);
      expect(getVisibleTeamById(updated.id)).toEqual(updated);
    });

    it('does not let a personal team shadow an active managed name', () => {
      useTeamStore.getState().registerManagedTeamSource('enterprise', () => true);
      useTeamStore.getState().replaceManagedTeams('enterprise', [managed]);
      expect(() => useTeamStore.getState().createTeam({
        name: managed.name, leaderRoleId: 'local-role', memberRoleIds: [],
      })).toThrow('duplicate team name');
    });

    it('does not let a personal team rename onto an active managed name', () => {
      const local = useTeamStore.getState().createTeam({
        name: '我的团队', leaderRoleId: 'local-role', memberRoleIds: [],
      });
      useTeamStore.getState().registerManagedTeamSource('enterprise', () => true);
      useTeamStore.getState().replaceManagedTeams('enterprise', [managed]);

      expect(() => useTeamStore.getState().updateTeam(local.id, { name: managed.name }))
        .toThrow('duplicate team name');
      expect(useTeamStore.getState().teams[0].name).toBe('我的团队');
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
      const stale: Team = { ...SOFTWARE_RD_TEAM, name: '旧名字', memberRoleIds: [] };
      const mine: Team = { id: 'team-mine', name: '我的小队', leaderRoleId: 'role-a', memberRoleIds: ['role-a'], createdAt: 1 };
      const merged = mergeTeamState({ teams: [mine, stale] }, useTeamStore.getState());
      // Order matters too: the user's teams first, then today's roster.
      expect(merged.teams).toEqual([mine, ...BUILTIN_TEAMS]);
      expect(merged.teams.some((t) => t.name === '旧名字')).toBe(false);
    });

    it('cannot be deleted or edited except for lastPlan', () => {
      useTeamStore.setState({ teams: [...BUILTIN_TEAMS] });
      const target = SOFTWARE_RD_TEAM;
      useTeamStore.getState().deleteTeam(target.id);
      expect(useTeamStore.getState().teams.find((t) => t.id === target.id)).toBeDefined();
      useTeamStore.getState().updateTeam(target.id, { name: '改名', lastPlan: { request: 'r', steps: ['s'], savedAt: 1 } });
      const after = useTeamStore.getState().teams.find((t) => t.id === target.id)!;
      expect(after.name).toBe(target.name);
      expect(after.lastPlan?.steps).toEqual(['s']);
    });

    it('renames a user team that a newly shipped built-in collided with', () => {
      // The roster grows between versions: a team the user named first can
      // collide with a built-in that did not exist when they created it.
      const mine: Team = { id: 'mine', name: SOFTWARE_RD_TEAM.name, leaderRoleId: 'role-a', memberRoleIds: ['role-a'], createdAt: 1, description: '我写的' };
      const merged = mergeTeamState({ teams: [mine] }, useTeamStore.getState());
      const kept = merged.teams.find((t) => t.id === 'mine')!;
      expect(kept.name).toBe(`${SOFTWARE_RD_TEAM.name} 2`);
      // Renamed, not dropped: everything the user wrote survives.
      expect(kept.description).toBe('我写的');
      expect(merged.teams.filter((t) => t.name === SOFTWARE_RD_TEAM.name)).toHaveLength(1);
    });

    it('leaves a team that merely looks like a suffix where it is', () => {
      // 「X 2」 is a name a user can legitimately create. Renaming it because
      // 「X」 next to it collided would silently re-point `@X 2` and save_team
      // at a different team — worse than the collision itself.
      const collider: Team = { id: 'a', name: SOFTWARE_RD_TEAM.name, leaderRoleId: 'role-a', memberRoleIds: ['role-a'], createdAt: 2 };
      const innocent: Team = { id: 'b', name: `${SOFTWARE_RD_TEAM.name} 2`, leaderRoleId: 'role-b', memberRoleIds: ['role-b'], createdAt: 1 };
      const merged = mergeTeamState({ teams: [collider, innocent] }, useTeamStore.getState());
      expect(merged.teams.find((t) => t.id === 'b')!.name).toBe(`${SOFTWARE_RD_TEAM.name} 2`);
      expect(merged.teams.find((t) => t.id === 'a')!.name).toBe(`${SOFTWARE_RD_TEAM.name} 3`);
    });

    it('is a fixed point: merging its own output changes nothing', () => {
      const mine: Team = { id: 'mine', name: SOFTWARE_RD_TEAM.name, leaderRoleId: 'role-a', memberRoleIds: ['role-a'], createdAt: 1 };
      const once = mergeTeamState({ teams: [mine] }, useTeamStore.getState());
      const twice = mergeTeamState({ teams: once.teams }, useTeamStore.getState());
      expect(twice.teams.find((t) => t.id === 'mine')!.name).toBe(`${SOFTWARE_RD_TEAM.name} 2`);
    });

    it('separates two persisted user teams that already share a name', () => {
      // Persisted order is newest-first (`createTeam` prepends), so the one
      // that keeps the name is whichever the array lists first.
      const newer: Team = { id: 'newer', name: '数据小队', leaderRoleId: 'role-a', memberRoleIds: ['role-a'], createdAt: 2 };
      const older: Team = { id: 'older', name: '数据小队', leaderRoleId: 'role-b', memberRoleIds: ['role-b'], createdAt: 1 };
      const merged = mergeTeamState({ teams: [newer, older] }, useTeamStore.getState());
      expect(merged.teams.find((t) => t.id === 'newer')!.name).toBe('数据小队');
      expect(merged.teams.find((t) => t.id === 'older')!.name).toBe('数据小队 2');
    });

    it('rejects a user team named like a built-in one', () => {
      useTeamStore.setState({ teams: [...BUILTIN_TEAMS] });
      expect(() => useTeamStore.getState().createTeam({ name: SOFTWARE_RD_TEAM.name, leaderRoleId: 'role-a', memberRoleIds: [] })).toThrow('duplicate team name');
    });
  });
});
