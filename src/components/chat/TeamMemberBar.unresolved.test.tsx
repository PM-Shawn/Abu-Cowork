// @vitest-environment happy-dom
/**
 * A team whose stored member no longer resolves runs with fewer people than
 * the team page suggests. The member strip is where the user looks during a
 * run, so it says so once — and, per brief D3, is also the way out: the pill
 * opens the team panel, where the member can be removed or replaced.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamRouteContext } from '@/core/team/leaderRoute';

const localeRef: { current: 'zh-CN' | 'en-US' } = { current: 'zh-CN' };
vi.mock('@/i18n', async () => {
  const { default: zhCN } = await import('@/i18n/locales/zh-CN');
  const { default: enUS } = await import('@/i18n/locales/en-US');
  const actual = await vi.importActual<typeof import('@/i18n')>('@/i18n');
  return {
    format: actual.format,
    useI18n: () => ({ t: localeRef.current === 'en-US' ? enUS : zhCN, locale: localeRef.current }),
  };
});
const openTeam = vi.fn();
const openSubagent = vi.fn();
vi.mock('@/stores/previewStore', () => ({
  usePreviewStore: (selector: (s: Record<string, unknown>) => unknown) => selector({ openSubagent, openTeam }),
}));
vi.mock('@/core/agent/dispatchCancel', () => ({ requestDispatchCancel: vi.fn() }));
vi.mock('@/components/common/AgentAvatar', () => ({ default: () => <span /> }));
// Reactive stand-in for the plugin store: only `activationReady` matters here.
vi.mock('@/stores/pluginStore', async () => {
  const { create } = await import('zustand');
  return { usePluginStore: create(() => ({ activationReady: true })) };
});

const teamRef: { team: TeamRouteContext | null } = { team: null };
vi.mock('@/components/team/useTeamDispatches', () => ({
  memberDefByName: (_team: TeamRouteContext, name: string) => ({ name, description: '' }),
  useTeamDispatches: () => ({
    team: teamRef.team,
    dispatches: [],
    members: (teamRef.team?.members ?? []).map((m) => ({ agent: m.name, status: 'idle', dispatches: [], latest: undefined })),
  }),
}));

import { usePluginStore } from '@/stores/pluginStore';
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
  beforeEach(() => {
    vi.clearAllMocks();
    localeRef.current = 'zh-CN';
    usePluginStore.setState({ activationReady: true });
  });

  it('claims nothing is unavailable until plugin records are ready, then shows the pill', () => {
    // Before the first installed.json read every file-backed expert fails to
    // resolve, so the count would be a false alarm.
    usePluginStore.setState({ activationReady: false });
    teamRef.team = ctx({ unresolvedMemberRoleIds: ['r-gone'] });
    render(<TeamMemberBar conversationId="c1" />);
    expect(screen.queryByTestId('team-member-bar-unresolved')).toBeNull();

    act(() => { usePluginStore.setState({ activationReady: true }); });

    expect(screen.getByTestId('team-member-bar-unresolved').textContent).toBe('1 名成员已失效');
  });

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

  it('also shows the unavailable pill when the strip is collapsed, and it still opens the team panel', () => {
    teamRef.team = ctx({ unresolvedMemberRoleIds: ['r-gone', 'r-gone2'] });
    render(<TeamMemberBar conversationId="c1" />);
    fireEvent.click(screen.getByRole('button', { name: '收起成员条' }));
    const bar = screen.getByTestId('team-member-bar');
    expect(bar).toHaveAttribute('data-collapsed', 'true');
    const pill = screen.getByTestId('team-member-bar-unresolved');
    expect(pill.textContent).toBe('2 名成员已失效');
    expect(pill.tagName).toBe('BUTTON');
    fireEvent.click(pill);
    expect(openTeam).toHaveBeenCalledWith('c1');
  });

  it('uses singular English copy for exactly one unavailable member', () => {
    localeRef.current = 'en-US';
    teamRef.team = ctx({ unresolvedMemberRoleIds: ['r-gone'] });
    render(<TeamMemberBar conversationId="c1" />);
    expect(screen.getByTestId('team-member-bar-unresolved').textContent).toBe('1 member unavailable');
  });

  it('uses plural English copy for two or more unavailable members (unchanged)', () => {
    localeRef.current = 'en-US';
    teamRef.team = ctx({ unresolvedMemberRoleIds: ['r-gone', 'r-gone2'] });
    render(<TeamMemberBar conversationId="c1" />);
    expect(screen.getByTestId('team-member-bar-unresolved').textContent).toBe('2 members unavailable');
  });

  it('uses singular English copy for the collapsed member-count pill when there is exactly one member', () => {
    localeRef.current = 'en-US';
    teamRef.team = ctx({ members: [{ name: 'a', description: '', systemPrompt: '', filePath: '/a' }] });
    render(<TeamMemberBar conversationId="c1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse member bar' }));
    expect(screen.getByTestId('team-member-bar')).toHaveTextContent('1 member');
    expect(screen.queryByTestId('team-member-bar')?.textContent).not.toContain('1 members');
  });
});
