import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useTeamStore } from '@/stores/teamStore';

const kickoffTask = vi.fn();
vi.mock('./orchestrator', () => ({ kickoffTask: (id: string) => kickoffTask(id) }));

import { tryHandleTeamMention } from './chatEntry';

describe('tryHandleTeamMention (composer entry)', () => {
  beforeEach(() => {
    useTeamStore.setState({ teams: [], tasks: [] });
    kickoffTask.mockClear();
  });

  function seedTeam(name = '数据小队') {
    return useTeamStore.getState().createTeam({ name, leaderRoleId: 'role-l', memberRoleIds: [] });
  }

  it('creates a task from @团队 with the goal stored verbatim and kicks it off', () => {
    seedTeam();
    const res = tryHandleTeamMention('@数据小队 出一版 8 月周报，异常波动单独列一节');
    expect(res.handled).toBe(true);
    const task = useTeamStore.getState().tasks[0];
    expect(task.goal).toBe('出一版 8 月周报，异常波动单独列一节');
    expect(kickoffTask).toHaveBeenCalledWith(task.id);
  });

  it('does not intercept non-team mentions — @agent keeps inline delegation', () => {
    seedTeam();
    const res = tryHandleTeamMention('@writer 帮我看看这段');
    expect(res.handled).toBe(false);
    expect(useTeamStore.getState().tasks).toHaveLength(0);
  });

  it('matches the longest team name and supports Chinese comma separators', () => {
    seedTeam('数据');
    seedTeam('数据小队');
    const res = tryHandleTeamMention('@数据小队，出周报');
    expect(res.handled && res.teamName).toBe('数据小队');
    expect(useTeamStore.getState().tasks[0].goal).toBe('出周报');
  });

  it('hands empty-goal mentions back with a named reason (composer keeps the text)', () => {
    seedTeam();
    const res = tryHandleTeamMention('@数据小队');
    expect(res.handled).toBe(false);
    expect(!res.handled && res.reason).toBe('empty_goal');
    expect(useTeamStore.getState().tasks).toHaveLength(0);
  });

  it('ignores archived teams', () => {
    const team = seedTeam();
    useTeamStore.getState().archiveTeam(team.id);
    expect(tryHandleTeamMention('@数据小队 干活').handled).toBe(false);
  });
});
