import { describe, it, expect, beforeEach } from 'vitest';
import { useTeamStore, selectPendingTasks } from './teamStore';

function reset() {
  useTeamStore.setState({ teams: [], tasks: [] });
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

  describe('createTask', () => {
    it('creates a task in awaiting_plan against an active team', () => {
      const team = useTeamStore.getState().createTeam({ name: 't', leaderRoleId: 'r', memberRoleIds: [] });
      const task = useTeamStore.getState().createTask({ teamId: team.id, goal: '出一版 8 月周报' });
      expect(task.status).toBe('awaiting_plan');
      expect(useTeamStore.getState().tasks).toHaveLength(1);
    });

    it('rejects empty goals, unknown teams, and archived teams', () => {
      const team = useTeamStore.getState().createTeam({ name: 't', leaderRoleId: 'r', memberRoleIds: [] });
      expect(() => useTeamStore.getState().createTask({ teamId: team.id, goal: '  ' })).toThrow();
      expect(() => useTeamStore.getState().createTask({ teamId: 'nope', goal: 'g' })).toThrow();
      useTeamStore.getState().archiveTeam(team.id);
      expect(() => useTeamStore.getState().createTask({ teamId: team.id, goal: 'g' })).toThrow();
    });
  });

  describe('selectPendingTasks', () => {
    it('surfaces exactly the states that need the user', () => {
      const team = useTeamStore.getState().createTeam({ name: 't', leaderRoleId: 'r', memberRoleIds: [] });
      const mk = (goal: string) => useTeamStore.getState().createTask({ teamId: team.id, goal });
      const a = mk('a'); const b = mk('b'); const c = mk('c'); const d = mk('d'); mk('e');
      useTeamStore.getState().updateTaskStatus(a.id, 'running');
      useTeamStore.getState().updateTaskStatus(b.id, 'pending_review');
      useTeamStore.getState().updateTaskStatus(c.id, 'blocked');
      useTeamStore.getState().updateTaskStatus(d.id, 'done');
      const pending = selectPendingTasks(useTeamStore.getState().tasks);
      expect(pending.map((task) => task.status).sort()).toEqual(['awaiting_plan', 'blocked', 'pending_review']);
    });
  });
});
