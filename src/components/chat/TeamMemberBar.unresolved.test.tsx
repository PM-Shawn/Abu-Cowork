// @vitest-environment happy-dom
/**
 * A team whose stored member no longer resolves runs with fewer people than
 * the team page suggests. The member strip is where the user looks during a
 * run, so it says so once — and, per brief D3, is also the way out: the pill
 * opens the team panel, where the member can be removed or replaced.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamRouteContext } from '@/core/team/leaderRoute';

vi.mock('@/i18n', async () => {
  const { default: zhCN } = await import('@/i18n/locales/zh-CN');
  const actual = await vi.importActual<typeof import('@/i18n')>('@/i18n');
  return { format: actual.format, useI18n: () => ({ t: zhCN, locale: 'zh-CN' }) };
});
const openTeam = vi.fn();
const openSubagent = vi.fn();
vi.mock('@/stores/previewStore', () => ({
  usePreviewStore: (selector: (s: Record<string, unknown>) => unknown) => selector({ openSubagent, openTeam }),
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
  beforeEach(() => { vi.clearAllMocks(); });

  it('shows a pill with the count when some members do not resolve, and it opens the team panel', () => {
    teamRef.team = ctx({ unresolvedMemberRoleIds: ['r-gone', 'r-gone2'] });
    render(<TeamMemberBar conversationId="c1" />);
    const pill = screen.getByTestId('team-member-bar-unresolved');
    expect(pill.textContent).toBe('2 名成员已失效');
    // Not a dead end: brief D3 asks for a way to act on it.
    expect(pill.tagName).toBe('BUTTON');
    fireEvent.click(pill);
    expect(openTeam).toHaveBeenCalledWith('c1');
  });

  it('shows nothing when every member resolves', () => {
    teamRef.team = ctx({ unresolvedMemberRoleIds: [] });
    render(<TeamMemberBar conversationId="c1" />);
    expect(screen.queryByTestId('team-member-bar-unresolved')).toBeNull();
  });
});
