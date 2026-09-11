// @vitest-environment happy-dom
/**
 * A team whose stored member no longer resolves runs with fewer people than
 * the team page suggests. The member strip is where the user looks during a
 * run, so it says so — once, as a muted pill, no button.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TeamRouteContext } from '@/core/team/leaderRoute';

vi.mock('@/i18n', async () => {
  const { default: zhCN } = await import('@/i18n/locales/zh-CN');
  const actual = await vi.importActual<typeof import('@/i18n')>('@/i18n');
  return { format: actual.format, useI18n: () => ({ t: zhCN, locale: 'zh-CN' }) };
});
vi.mock('@/stores/previewStore', () => ({
  usePreviewStore: (selector: (s: Record<string, unknown>) => unknown) => selector({ openSubagent: vi.fn(), openTeam: vi.fn() }),
}));
vi.mock('@/core/agent/dispatchCancel', () => ({ requestDispatchCancel: vi.fn() }));
vi.mock('@/components/common/AgentAvatar', () => ({ default: () => <span /> }));

const teamRef: { team: TeamRouteContext | null } = { team: null };
vi.mock('@/components/team/useTeamDispatches', () => ({
  memberDefByName: (_team: TeamRouteContext, name: string) => ({ name, description: '' }),
  useTeamDispatches: () => ({
    team: teamRef.team,
    dispatches: [],
    members: (teamRef.team?.members ?? []).map((m) => ({ agent: m.name, status: 'idle', dispatches: [], latest: undefined })),
  }),
}));

import TeamMemberBar from './TeamMemberBar';

function ctx(extra: Partial<TeamRouteContext>): TeamRouteContext {
  return {
    teamId: 't', teamName: '数据小队',
    leader: { name: 'lead', description: '', systemPrompt: '', filePath: '/l' },
    members: [{ name: 'a', description: '', systemPrompt: '', filePath: '/a' }],
    ...extra,
  };
}

describe('TeamMemberBar — unresolved members', () => {
  it('shows a muted pill with the count when some members do not resolve', () => {
    teamRef.team = ctx({ unresolvedMemberRoleIds: ['r-gone', 'r-gone2'] });
    render(<TeamMemberBar conversationId="c1" />);
    expect(screen.getByTestId('team-member-bar-unresolved').textContent).toBe('2 名成员已失效');
  });

  it('shows nothing when every member resolves', () => {
    teamRef.team = ctx({ unresolvedMemberRoleIds: [] });
    render(<TeamMemberBar conversationId="c1" />);
    expect(screen.queryByTestId('team-member-bar-unresolved')).toBeNull();
  });
});
