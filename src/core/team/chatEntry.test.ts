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
  it('handles an attachment marker that precedes the mention', () => {
    // ChatInput prepends `[Attachment: …]` ahead of the user's text whenever
    // the mention was typed inline rather than picked from the popup — the
    // team route must not silently disappear as soon as a file is attached.
    useTeamStore.setState({
      teams: [{ id: 'tm1', name: '数据小队', leaderRoleId: 'r1', memberRoleIds: ['r1'], createdAt: 1 }],
      tasks: [],
    });
    const result = tryHandleTeamMention('[Attachment: `/tmp/8月数据.xlsx`]\n\n@数据小队 出一版周报');
    expect(result.handled).toBe(true);
    const task = useTeamStore.getState().tasks[0];
    expect(task.goal).toBe('出一版周报');
    expect(task.attachments).toEqual(['/tmp/8月数据.xlsx']);
  });
  it('refuses instead of silently degrading when a quoted reference precedes the mention', () => {
    // References are prepended ahead of the user's text like attachments are,
    // but they carry blockquotes we cannot safely split back out — so the
    // hand-off is refused out loud rather than becoming an ordinary chat turn.
    useTeamStore.setState({
      teams: [{ id: 'tm1', name: '数据小队', leaderRoleId: 'r1', memberRoleIds: ['r1'], createdAt: 1 }],
      tasks: [],
    });
    const result = tryHandleTeamMention('[引用 1 · 来源：周报.md]\n> 上周完成了三件事\n\n@数据小队 出一版周报');
    expect(result.handled).toBe(false);
    expect(result.handled === false && result.reason).toBe('unsupported_context');
    expect(result.handled === false && result.teamName).toBe('数据小队');
    expect(useTeamStore.getState().tasks).toHaveLength(0);
  });

  it('refuses a team mention that carries images, which cannot reach a task', () => {
    useTeamStore.setState({
      teams: [{ id: 'tm1', name: '数据小队', leaderRoleId: 'r1', memberRoleIds: ['r1'], createdAt: 1 }],
      tasks: [],
    });
    const result = tryHandleTeamMention('@数据小队 看看这张图', { hasImages: true });
    expect(result.handled).toBe(false);
    expect(result.handled === false && result.reason).toBe('unsupported_context');
    expect(useTeamStore.getState().tasks).toHaveLength(0);
  });
});
