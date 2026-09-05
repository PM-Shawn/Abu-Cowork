import { describe, it, expect, vi } from 'vitest';
import type { SubagentDefinition } from '@/types';

const defs: Record<string, Partial<SubagentDefinition>> = {
  'r-lead': { name: 'zz数据分析师', description: 'lead', avatar: '📊' },
  'r-plain': { name: '无头像队长', description: 'lead' },
};
vi.mock('@/core/team/roleIdentity', () => ({
  resolveRoleId: (roleId: string) => (defs[roleId] as SubagentDefinition) ?? null,
}));

import { teamLeaderFromTeam } from './useConversationTeamLeader';
import type { Team } from '@/stores/teamStore';

const team = (over: Partial<Team> = {}): Team => ({
  id: 't1', name: 'zz数据小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead'], createdAt: 1, ...over,
} as Team);

describe('teamLeaderFromTeam', () => {
  it('resolves the leader definition and the team avatar', () => {
    expect(teamLeaderFromTeam(team())).toMatchObject({ teamId: 't1', teamName: 'zz数据小队', leaderName: 'zz数据分析师', teamAvatar: null });
    expect(teamLeaderFromTeam(team())?.leader.avatar).toBe('📊');
    expect(teamLeaderFromTeam(team({ avatar: '🚀' }))?.teamAvatar).toBe('🚀');
  });
  it('is null for archived teams, missing leaders, or no team', () => {
    expect(teamLeaderFromTeam(team({ archivedAt: 5 }))).toBeNull();
    expect(teamLeaderFromTeam(team({ leaderRoleId: 'r-gone' }))).toBeNull();
    expect(teamLeaderFromTeam(null)).toBeNull();
  });
});
