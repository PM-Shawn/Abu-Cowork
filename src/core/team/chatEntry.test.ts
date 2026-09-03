import { describe, it, expect, beforeEach } from 'vitest';
import { useTeamStore } from '@/stores/teamStore';
import { matchTeamMention } from './chatEntry';

describe('matchTeamMention (composer fallback for a typed @团队)', () => {
  beforeEach(() => {
    useTeamStore.setState({ teams: [], tasks: [] });
  });

  function seedTeam(name = '数据小队') {
    return useTeamStore.getState().createTeam({ name, leaderRoleId: 'role-l', memberRoleIds: [] });
  }

  it('names the team and returns the message without the mention', () => {
    const team = seedTeam();
    const res = matchTeamMention('@数据小队 出一版 8 月周报，异常波动单独列一节');
    expect(res).toEqual({ teamId: team.id, teamName: '数据小队', rest: '出一版 8 月周报，异常波动单独列一节' });
  });

  it('does not match non-team mentions — @agent keeps inline delegation', () => {
    seedTeam();
    expect(matchTeamMention('@writer 帮我看看这段')).toBeNull();
    expect(matchTeamMention('@数据小队长 出周报')).toBeNull(); // prefix of a longer word is not the team
  });

  it('matches the longest team name and supports Chinese comma separators', () => {
    seedTeam('数据');
    const long = seedTeam('数据小队');
    const res = matchTeamMention('@数据小队，出周报');
    expect(res?.teamId).toBe(long.id);
    expect(res?.rest).toBe('出周报');
  });

  it('returns an empty rest for a bare mention so the caller can hand the text back', () => {
    seedTeam();
    expect(matchTeamMention('@数据小队')).toMatchObject({ teamName: '数据小队', rest: '' });
  });

  it('ignores archived teams', () => {
    const team = seedTeam();
    useTeamStore.getState().archiveTeam(team.id);
    expect(matchTeamMention('@数据小队 干活')).toBeNull();
  });

  it('keeps attachment markers that precede the mention in the message', () => {
    seedTeam();
    const res = matchTeamMention('[Attachment: `/tmp/a.csv`]\n@数据小队 看看这份数据');
    expect(res?.teamName).toBe('数据小队');
    expect(res?.rest).toBe('[Attachment: `/tmp/a.csv`]\n看看这份数据');
  });

  it('does not treat a mention buried behind other text as a team hand-off', () => {
    seedTeam();
    expect(matchTeamMention('> quoted\n@数据小队 干活')).toBeNull();
  });
});
