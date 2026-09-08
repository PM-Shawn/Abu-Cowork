import { describe, it, expect, beforeEach } from 'vitest';
import { useTeamStore } from './teamStore';

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

    it('allows reusing the name of an archived team (failure is visible, name is not)', () => {
      const s = useTeamStore.getState();
      const team = s.createTeam({ name: 't', leaderRoleId: 'r', memberRoleIds: [] });
      useTeamStore.getState().archiveTeam(team.id);
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

  describe('archive / restore', () => {
    it('round-trips archivedAt', () => {
      const team = useTeamStore.getState().createTeam({ name: 't', leaderRoleId: 'r', memberRoleIds: [] });
      useTeamStore.getState().archiveTeam(team.id);
      expect(useTeamStore.getState().teams[0].archivedAt).toBeDefined();
      useTeamStore.getState().restoreTeam(team.id);
      expect(useTeamStore.getState().teams[0].archivedAt).toBeUndefined();
    });
  });
});
