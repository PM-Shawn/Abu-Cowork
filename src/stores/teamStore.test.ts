import { describe, it, expect, beforeEach } from 'vitest';
import { migrateTeamState, useTeamStore } from './teamStore';

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
});
