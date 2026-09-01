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
    it('surfaces review + blocked; planning is visible-not-blocking by default', () => {
      const team = useTeamStore.getState().createTeam({ name: 't', leaderRoleId: 'r', memberRoleIds: [] });
      const mk = (goal: string) => useTeamStore.getState().createTask({ teamId: team.id, goal });
      const a = mk('a'); const b = mk('b'); const c = mk('c'); const d = mk('d'); mk('e');
      useTeamStore.getState().updateTaskStatus(a.id, 'running');
      useTeamStore.getState().updateTaskStatus(b.id, 'pending_review');
      useTeamStore.getState().updateTaskStatus(c.id, 'blocked');
      useTeamStore.getState().updateTaskStatus(d.id, 'done');
      const state = useTeamStore.getState();
      const pending = selectPendingTasks(state.tasks, state.teams);
      // awaiting_plan does NOT count by default (no proposal waiting on the user).
      expect(pending.map((task) => task.status).sort()).toEqual(['blocked', 'pending_review']);
    });

    it('a proposed plan waits on the user only in strict (requirePlanApproval) teams', () => {
      const strict = useTeamStore.getState().createTeam({ name: 'strict', leaderRoleId: 'r', memberRoleIds: [], requirePlanApproval: true });
      const loose = useTeamStore.getState().createTeam({ name: 'loose', leaderRoleId: 'r2', memberRoleIds: [] });
      const ts = useTeamStore.getState().createTask({ teamId: strict.id, goal: 'a' });
      const tl = useTeamStore.getState().createTask({ teamId: loose.id, goal: 'b' });
      const plan = { items: [{ id: '1', memberRoleId: 'r', what: 'x', dependsOn: [], state: 'pending' as const }], doneWhen: [] };
      useTeamStore.getState().proposePlan(ts.id, plan);
      useTeamStore.getState().proposePlan(tl.id, { ...plan, items: [{ ...plan.items[0], memberRoleId: 'r2' }] });
      const state = useTeamStore.getState();
      const pending = selectPendingTasks(state.tasks, state.teams);
      expect(pending.map((task) => task.id)).toEqual([ts.id]);
    });
  });

  describe('single-member tasks', () => {
    it('accepts a memberRoleId assignee and rejects ambiguous/empty assignment', () => {
      const task = useTeamStore.getState().createTask({ memberRoleId: 'role-x', goal: 'g' });
      expect(task.memberRoleId).toBe('role-x');
      expect(task.teamId).toBeUndefined();
      const team = useTeamStore.getState().createTeam({ name: 't', leaderRoleId: 'r', memberRoleIds: [] });
      expect(() => useTeamStore.getState().createTask({ teamId: team.id, memberRoleId: 'role-x', goal: 'g' })).toThrow();
      expect(() => useTeamStore.getState().createTask({ goal: 'g' })).toThrow();
    });
  });


});
