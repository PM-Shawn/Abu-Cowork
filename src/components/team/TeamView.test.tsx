// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTeamStore } from '@/stores/teamStore';

// TeamView reads/writes the real teamStore (zustand works fine in tests);
// everything else is mocked at the boundary, mirroring ToolboxModal.test.tsx.

const settingsState = {
  activeTeamTab: 'tasks' as 'inbox' | 'tasks' | 'members' | 'teams',
  toolboxSearchQuery: '',
  setToolboxSearchQuery: vi.fn((value: string) => { settingsState.toolboxSearchQuery = value; }),
  disabledAgents: [] as string[],
  setActiveTeamTab: vi.fn((tab: 'inbox' | 'tasks' | 'members' | 'teams') => {
    settingsState.activeTeamTab = tab;
  }),
  closeTeam: vi.fn(),
};

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector?: (state: Record<string, unknown>) => unknown) =>
    selector ? selector(settingsState) : settingsState,
}));

const chatState = {
  setPendingInput: vi.fn(),
  startNewConversation: vi.fn(),
  switchConversation: vi.fn(),
  createConversation: vi.fn(() => 'c-new'),
  conversationIndex: {} as Record<string, { id: string; title: string; updatedAt: number; teamId?: string; workspacePath?: string | null }>,
};
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: Record<string, unknown>) => unknown) => selector(chatState),
}));

const loadMessages = vi.fn();
vi.mock('@/core/session/conversationStorage', () => ({ loadMessages: (id: string) => loadMessages(id) }));

const discoveryState = { agents: [] as Array<{ name: string }>, refresh: vi.fn() };
vi.mock('@/stores/discoveryStore', () => ({
  useDiscoveryStore: (selector?: (state: Record<string, unknown>) => unknown) =>
    selector ? selector(discoveryState) : discoveryState,
}));

const addToast = vi.fn();
vi.mock('@/stores/toastStore', () => ({
  useToastStore: (selector: (state: Record<string, unknown>) => unknown) => selector({ addToast }),
}));

// Pin the real zh-CN copy (assertions below are the product copy the user reviews);
// a test may switch to en-US for plural checks.
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

// Reactive stand-in for the plugin store: only `activationReady` matters here.
vi.mock('@/stores/pluginStore', async () => {
  const { create } = await import('zustand');
  return { usePluginStore: create(() => ({ activationReady: true })) };
});
import { usePluginStore } from '@/stores/pluginStore';

type RegistryAgent = { name: string; description: string; roleId?: string; filePath: string; systemPrompt: string; managed?: boolean; source?: { kind: 'plugin'; plugin: string } };
const registryAgents: Record<string, RegistryAgent> = {};
/** Mirrors activationPolicy: until plugin records are ready, a file-backed agent is hidden. */
const gated = (agent: RegistryAgent | undefined): RegistryAgent | undefined =>
  agent && !agent.filePath.startsWith('__') && !usePluginStore.getState().activationReady ? undefined : agent;
vi.mock('@/core/agent/registry', () => ({
  agentRegistry: {
    getAgent: (name: string) => gated(registryAgents[name]),
    getAvailableAgents: () => Object.values(registryAgents),
  },
  serializeAgentMd: vi.fn(() => 'md'),
}));

// TaskDetailDialog pulls the orchestrator (heavy loop graph) — stub it.
vi.mock('@/core/team/orchestrator', () => ({
  kickoffTask: vi.fn(),
  startMemberTask: vi.fn(async () => undefined),
  startPlanning: vi.fn(async () => undefined),
  requestPlanAdjustment: vi.fn(async () => undefined),
  confirmAndExecute: vi.fn(async () => undefined),
  acceptTask: vi.fn(),
  rejectTask: vi.fn(async () => undefined),
  retryItem: vi.fn(async () => undefined),
  stopTask: vi.fn(async () => undefined),
  runScheduledTeamTask: vi.fn(async () => ({ ok: true, taskId: 'tk' })),
}));

vi.mock('@/core/team/roleIdentity', () => ({
  ensureRoleId: vi.fn(async (agent: { roleId?: string }) =>
    agent.roleId ? { roleId: agent.roleId, wrote: false } : { roleId: 'role-new', wrote: true }),
  // Mirrors the real module: a plugin-owned agent's identity is name-keyed,
  // whatever `role-…` id its frontmatter may still carry.
  effectiveRoleId: (agent: { roleId?: string; name: string; source?: { kind: string } }) =>
    agent.source?.kind === 'plugin' ? `plugin:${agent.name}` : (agent.roleId ?? `builtin:${agent.name}`),
  isBuiltinAgent: () => false,
  resolveRoleId: (roleId: string) =>
    gated(Object.values(registryAgents).find((a) => (a.roleId ?? `builtin:${a.name}`) === roleId)) ?? null,
  roleIdAgentName: (roleId: string) => /^(?:builtin|plugin):(.+)$/.exec(roleId)?.[1],
}));

// AgentsSection drags in the whole toolbox world — stub it. The stub keeps the
// real component's one contract with TeamView: it opens a blank editor from an
// effect whenever it sees `manualCreateTrigger > 0` (counted in `editorOpens`),
// and exposes the value it received as `data-trigger`.
const editorOpens = vi.fn();
vi.mock('@/components/customize/AgentsSection', async () => {
  const { useEffect } = await import('react');
  return {
    default: function AgentsSectionStub({ manualCreateTrigger }: { manualCreateTrigger?: number }) {
      useEffect(() => {
        if (manualCreateTrigger && manualCreateTrigger > 0) editorOpens();
      }, [manualCreateTrigger]);
      return <div data-testid="agents-section" data-trigger={String(manualCreateTrigger ?? 0)} />;
    },
  };
});

import TeamView from './TeamView';

type SeedExtra = { roleId?: string; skills?: string[]; source?: { kind: 'plugin'; plugin: string } };
function seedAgent(name: string, extra?: string | SeedExtra) {
  const { roleId, skills, source } = typeof extra === 'string' ? ({ roleId: extra } as SeedExtra) : (extra ?? {});
  const agent = { name, description: `${name} desc`, roleId, skills, source, filePath: `/agents/${name}/AGENT.md`, systemPrompt: '' };
  registryAgents[name] = agent;
  return agent;
}

describe('TeamView', () => {
  beforeEach(() => {
    useTeamStore.setState({ teams: []});
    settingsState.activeTeamTab = 'members';
    for (const key of Object.keys(registryAgents)) delete registryAgents[key];
    discoveryState.agents = [];
    chatState.conversationIndex = {};
    usePluginStore.setState({ activationReady: true });
    localeRef.current = 'zh-CN';
    vi.clearAllMocks();
  });

  // P1: at launch discovery publishes BEFORE the first installed.json read, and
  // until then every file-backed expert is hidden. Readiness is the only thing
  // that changes, so the team page must re-resolve on it.
  it('teams tab: the card and the open detail re-resolve user experts when plugin records become ready', () => {
    usePluginStore.setState({ activationReady: false });
    settingsState.activeTeamTab = 'teams';
    seedAgent('分析师', { roleId: 'r-lead' });
    seedAgent('校对', { roleId: 'r-mem' });
    discoveryState.agents = [{ name: '分析师' }, { name: '校对' }];
    useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead', 'r-mem'], createdAt: 1 }] });
    render(<TeamView />);
    expect(screen.getByTestId('team-row-数据小队').textContent).toContain('0 名成员');
    fireEvent.click(screen.getByTestId('team-row-数据小队'));
    expect(screen.getByText('成员（0）')).toBeTruthy();

    act(() => { usePluginStore.setState({ activationReady: true }); });

    expect(screen.getByTestId('team-row-数据小队').textContent).toContain('队长：分析师 · 1 名成员');
    expect(screen.getByText('成员（1）')).toBeTruthy();
    expect(screen.queryByTestId('team-member-invalid-r-mem')).toBeNull();
  });

  it('team dialog: opened before plugin records are ready, it re-seeds once they are — real members back in the picker', () => {
    usePluginStore.setState({ activationReady: false });
    settingsState.activeTeamTab = 'teams';
    seedAgent('分析师', { roleId: 'r-lead' });
    seedAgent('校对', { roleId: 'r-mem' });
    discoveryState.agents = [{ name: '分析师' }, { name: '校对' }];
    useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead', 'r-mem'], createdAt: 1 }] });
    render(<TeamView />);
    fireEvent.click(screen.getByTestId('team-row-数据小队'));
    fireEvent.click(screen.getByTestId('team-detail-menu'));
    fireEvent.click(screen.getByTestId('team-detail-edit'));
    expect(screen.getByTestId('team-edit-invalid-r-mem')).toBeTruthy();

    act(() => { usePluginStore.setState({ activationReady: true }); });

    expect(screen.queryByTestId('team-edit-invalid-r-mem')).toBeNull();
    expect(screen.getByTestId('team-members-select').textContent).toContain('校对');
    expect(screen.getByTestId('team-leader-select').textContent).toContain('分析师');
  });

  it('team dialog: a later ready→not-ready blip (a plugin install) does not wipe what the user typed', () => {
    settingsState.activeTeamTab = 'teams';
    seedAgent('分析师', { roleId: 'r-lead' });
    discoveryState.agents = [{ name: '分析师' }];
    useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead'], createdAt: 1 }] });
    render(<TeamView />);
    fireEvent.click(screen.getByTestId('team-row-数据小队'));
    fireEvent.click(screen.getByTestId('team-detail-menu'));
    fireEvent.click(screen.getByTestId('team-detail-edit'));
    fireEvent.change(screen.getByTestId('team-name-input'), { target: { value: '新名字' } });

    act(() => { usePluginStore.setState({ activationReady: false }); });
    act(() => { usePluginStore.setState({ activationReady: true }); });

    expect((screen.getByTestId('team-name-input') as HTMLInputElement).value).toBe('新名字');
  });

  it('renders the two tabs 队员·团队 (the task board is gone)', () => {
    render(<TeamView />);
    const tabs = screen.getAllByRole('button').map((b) => b.textContent).filter((label) =>
      ['收件箱', '任务', '队员', '团队'].includes(label ?? ''));
    expect(tabs).toEqual(['队员', '团队']);
  });

  it('teams tab empty state offers creating a team', () => {
    settingsState.activeTeamTab = 'teams';
    render(<TeamView />);
    expect(screen.getByText('还没有团队')).toBeTruthy();
    expect(screen.getAllByText('新建团队').length).toBeGreaterThan(0);
  });

  it('teams tab: a row opens the detail, not the edit form — and shows leader, members and the merged skills', () => {
    settingsState.activeTeamTab = 'teams';
    seedAgent('分析师', { roleId: 'r-lead', skills: ['取数', '画图'] });
    seedAgent('校对', { roleId: 'r-mem', skills: ['画图', '核对'] });
    discoveryState.agents = [{ name: '分析师' }, { name: '校对' }];
    useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead', 'r-mem'], createdAt: 1 }] });
    render(<TeamView />);
    fireEvent.click(screen.getByTestId('team-row-数据小队'));
    // Detail, not the edit form: the primary action is starting work, and the
    // name field only exists behind "…" → 编辑.
    expect(screen.getByTestId('team-detail-start-chat')).toBeTruthy();
    expect(screen.queryByTestId('team-name-input')).toBeNull();
    expect(screen.getByText('队长')).toBeTruthy();
    expect(screen.getByText('成员（1）')).toBeTruthy();
    // Skills live on members; the union is deduplicated and sorted.
    for (const skill of ['取数', '画图', '核对']) expect(screen.getByText(skill)).toBeTruthy();
  });

  it('teams tab: the card counts only members that resolve, matching the runtime roster', () => {
    settingsState.activeTeamTab = 'teams';
    seedAgent('分析师', { roleId: 'r-lead' });
    seedAgent('校对', { roleId: 'r-mem' });
    discoveryState.agents = [{ name: '分析师' }, { name: '校对' }];
    useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead', 'r-mem', 'r-gone'], createdAt: 1 }] });
    render(<TeamView />);
    expect(screen.getByTestId('team-row-数据小队').textContent).toContain('1 名成员');
  });

  it('teams tab: the English card says "1 member" for one member and "2 members" for two', () => {
    localeRef.current = 'en-US';
    settingsState.activeTeamTab = 'teams';
    seedAgent('lead', { roleId: 'r-lead' });
    seedAgent('a', { roleId: 'r-a' });
    seedAgent('b', { roleId: 'r-b' });
    discoveryState.agents = [{ name: 'lead' }, { name: 'a' }, { name: 'b' }];
    useTeamStore.setState({ teams: [
      { id: 't1', name: 'Solo', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead', 'r-a'], createdAt: 1 },
      { id: 't2', name: 'Pair', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead', 'r-a', 'r-b'], createdAt: 2 },
    ] });
    render(<TeamView />);
    expect(screen.getByTestId('team-row-Solo').textContent).toContain('Leader: lead · 1 member');
    expect(screen.getByTestId('team-row-Solo').textContent).not.toContain('1 members');
    expect(screen.getByTestId('team-row-Pair').textContent).toContain('Leader: lead · 2 members');
  });

  it('teams tab: the card labels an unresolvable leader as invalid, matching the detail', () => {
    settingsState.activeTeamTab = 'teams';
    seedAgent('校对', { roleId: 'r-mem' });
    discoveryState.agents = [{ name: '校对' }];
    useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'r-gone-lead', memberRoleIds: ['r-gone-lead', 'r-mem'], createdAt: 1 }] });
    render(<TeamView />);
    const card = screen.getByTestId('team-row-数据小队');
    // Short copy: the card summary is one ` · ` line, not a place for the
    // explanatory clause (that stays in the detail row).
    expect(card.textContent).toContain('已失效');
    expect(card.textContent).not.toContain('专家已删除');
    expect(card.textContent).toContain('1 名成员');
  });

  it('teams tab: an unresolvable leader in the detail is the same two-line ghost as a member, without 移除', () => {
    settingsState.activeTeamTab = 'teams';
    seedAgent('校对', { roleId: 'r-mem' });
    discoveryState.agents = [{ name: '校对' }];
    useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'role-gone-lead', memberRoleIds: ['role-gone-lead', 'r-mem'], createdAt: 1 }] });
    render(<TeamView />);
    fireEvent.click(screen.getByTestId('team-row-数据小队'));
    const ghost = screen.getByTestId('team-leader-invalid');
    const [primary, caption] = Array.from(ghost.querySelectorAll('span > span')).map((el) => el.textContent);
    expect(primary).toBe('已失效');
    expect(caption).toBe('专家已删除、修改，或所属插件已停用');
    // A leader is replaced via 编辑, never removed from the detail.
    expect(ghost.querySelector('button')).toBeNull();
    expect(screen.queryByText('移除')).toBeNull();
    // The leader is not a member: it never joins the member ghosts.
    expect(screen.queryByTestId('team-member-invalid-role-gone-lead')).toBeNull();
  });

  it('teams tab: an unresolvable leader whose id carries a name is shown by that name', () => {
    settingsState.activeTeamTab = 'teams';
    useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'builtin:产品经理', memberRoleIds: ['builtin:产品经理'], createdAt: 1 }] });
    render(<TeamView />);
    fireEvent.click(screen.getByTestId('team-row-数据小队'));
    const ghost = screen.getByTestId('team-leader-invalid');
    expect(ghost.textContent).toContain('「产品经理」已失效');
    expect(ghost.textContent).toContain('专家已删除、修改，或所属插件已停用');
  });

  it('teams tab: the detail labels an unresolvable member as invalid and removes it on request', () => {
    settingsState.activeTeamTab = 'teams';
    seedAgent('分析师', { roleId: 'r-lead' });
    seedAgent('校对', { roleId: 'r-mem' });
    discoveryState.agents = [{ name: '分析师' }, { name: '校对' }];
    useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead', 'r-mem', 'r-gone'], createdAt: 1 }] });
    render(<TeamView />);
    fireEvent.click(screen.getByTestId('team-row-数据小队'));
    expect(screen.getByText('成员（1）')).toBeTruthy();
    const invalidRow = screen.getByTestId('team-member-invalid-r-gone');
    expect(invalidRow.textContent).toContain('已失效');
    fireEvent.click(screen.getByText('移除'));
    expect(useTeamStore.getState().teams[0].memberRoleIds).toEqual(['r-lead', 'r-mem']);
    expect(screen.queryByTestId('team-member-invalid-r-gone')).toBeNull();
  });

  it('team dialog: an invalid member is listed, kept on save unless removed', async () => {
    settingsState.activeTeamTab = 'teams';
    seedAgent('分析师', { roleId: 'r-lead' });
    discoveryState.agents = [{ name: '分析师' }];
    useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead', 'r-gone'], createdAt: 1 }] });
    render(<TeamView />);
    fireEvent.click(screen.getByTestId('team-row-数据小队'));
    fireEvent.click(screen.getByTestId('team-detail-menu'));
    fireEvent.click(screen.getByTestId('team-detail-edit'));
    expect(screen.getByTestId('team-edit-invalid-r-gone')).toBeTruthy();
    // Save without touching it: the ghost is preserved (never silently dropped).
    fireEvent.click(screen.getByTestId('team-save'));
    await waitFor(() => expect(useTeamStore.getState().teams[0].memberRoleIds).toEqual(['r-lead', 'r-gone']));
    // Reopen, remove, save: now it is gone.
    fireEvent.click(screen.getByTestId('team-row-数据小队'));
    fireEvent.click(screen.getByTestId('team-detail-menu'));
    fireEvent.click(screen.getByTestId('team-detail-edit'));
    fireEvent.click(screen.getByTestId('team-edit-invalid-remove-r-gone'));
    expect(screen.queryByTestId('team-edit-invalid-r-gone')).toBeNull();
    fireEvent.click(screen.getByTestId('team-save'));
    await waitFor(() => expect(useTeamStore.getState().teams[0].memberRoleIds).toEqual(['r-lead']));
  });

  it('team dialog: a plugin member stored under its legacy role- id stays in the picker', () => {
    // Teams saved before plugin agents got synthetic `plugin:<name>` ids hold
    // the frontmatter `role-…` id. It must still resolve to the picker chip —
    // otherwise the member silently drops out and can be re-added as a duplicate.
    settingsState.activeTeamTab = 'teams';
    seedAgent('分析师', { roleId: 'r-lead' });
    seedAgent('校对', { roleId: 'role-legacy', source: { kind: 'plugin', plugin: 'x@official' } });
    discoveryState.agents = [{ name: '分析师' }, { name: '校对' }];
    useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead', 'role-legacy'], createdAt: 1 }] });
    render(<TeamView />);
    fireEvent.click(screen.getByTestId('team-row-数据小队'));
    fireEvent.click(screen.getByTestId('team-detail-menu'));
    fireEvent.click(screen.getByTestId('team-detail-edit'));
    expect(screen.getByTestId('team-members-select').textContent).toContain('校对');
    expect(screen.queryByTestId('team-edit-invalid-role-legacy')).toBeNull();
  });

  it('teams tab: the detail\'s primary action opens a conversation already pinned to the team', () => {
    settingsState.activeTeamTab = 'teams';
    useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'r1', memberRoleIds: ['r1'], createdAt: 1 }] });
    render(<TeamView />);
    fireEvent.click(screen.getByTestId('team-row-数据小队'));
    fireEvent.click(screen.getByTestId('team-detail-start-chat'));
    expect(chatState.createConversation).toHaveBeenCalledWith(null, { teamId: 't1' });
    // Nothing prefilled: the user says what they want in their own words.
    expect(chatState.setPendingInput).not.toHaveBeenCalled();
  });

  it('teams tab: 编辑 lives behind the detail\'s "…" menu, mirroring the 队员 detail', () => {
    settingsState.activeTeamTab = 'teams';
    useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'r1', memberRoleIds: ['r1'], createdAt: 1 }] });
    render(<TeamView />);
    fireEvent.click(screen.getByTestId('team-row-数据小队'));
    fireEvent.click(screen.getByTestId('team-detail-menu'));
    fireEvent.click(screen.getByTestId('team-detail-edit'));
    expect(screen.getByTestId('team-name-input')).toBeTruthy();
  });

  it('teams tab: creating offers 使用阿布创建 alongside 手动创建 (parity with 队员)', () => {
    settingsState.activeTeamTab = 'teams';
    render(<TeamView />);
    fireEvent.click(screen.getByTestId('team-create-trigger'));
    const menu = screen.getByTestId('team-create-menu');
    expect(menu.textContent).toContain('使用阿布创建');
    expect(menu.textContent).toContain('手动创建');
  });

  it('team dialog: create button stays disabled until name + leader are set', async () => {
    seedAgent('writer');
    discoveryState.agents = [{ name: 'writer' }];
    settingsState.activeTeamTab = 'teams';
    render(<TeamView />);
    fireEvent.click(screen.getAllByText('新建团队')[0]);
    const save = screen.getByTestId('team-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByTestId('team-name-input'), { target: { value: '数据小队' } });
    expect(save.disabled).toBe(true); // still no leader

    // Leader is its own searchable dropdown (user feedback 2026-08-31).
    fireEvent.click(screen.getByTestId('team-leader-select'));
    fireEvent.click(screen.getByTestId('search-select-option-writer'));
    expect(save.disabled).toBe(false);

    fireEvent.click(save);
    await waitFor(() => expect(useTeamStore.getState().teams).toHaveLength(1));
    const team = useTeamStore.getState().teams[0];
    expect(team.name).toBe('数据小队');
    expect(team.leaderRoleId).toBe('role-new');
    expect(addToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('team dialog with zero agents offers 新建队员 instead of a dead end', () => {
    settingsState.activeTeamTab = 'teams';
    render(<TeamView />);
    fireEvent.click(screen.getAllByText('新建团队')[0]);
    expect(screen.getByText('新建队员')).toBeTruthy();
  });

  it('members tab renders the shared AgentsSection (single identity source)', () => {
    settingsState.activeTeamTab = 'members';
    render(<TeamView />);
    expect(screen.getByTestId('agents-section')).toBeTruthy();
  });

  it('members tab: leaving and coming back does not replay 手动创建 (no blank editor on return)', () => {
    settingsState.activeTeamTab = 'members';
    // The settings mock is a plain object, so a tab click needs a rerender to show.
    const { rerender } = render(<TeamView />);
    fireEvent.click(screen.getByTestId('member-create-trigger'));
    fireEvent.click(screen.getByText('手动创建'));
    expect(screen.getByTestId('agents-section').getAttribute('data-trigger')).toBe('1');
    expect(editorOpens).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('团队'));
    rerender(<TeamView />);
    fireEvent.click(screen.getByText('队员'));
    rerender(<TeamView />);
    expect(screen.getByTestId('agents-section').getAttribute('data-trigger')).toBe('0');
    expect(editorOpens).toHaveBeenCalledTimes(1);
  });

  it('team dialog: 新建队员 switches to 队员 and opens the blank editor exactly once', () => {
    // The tab switch and the trigger bump land in one commit: the section mounts
    // with the bumped value and opens the editor before the tab-change reset runs.
    settingsState.activeTeamTab = 'teams';
    const { rerender } = render(<TeamView />);
    fireEvent.click(screen.getAllByText('新建团队')[0]);
    fireEvent.click(screen.getByText('新建队员'));
    expect(screen.getByTestId('agents-section')).toBeTruthy();
    expect(editorOpens).toHaveBeenCalledTimes(1);
    // …and the reset means a later return to 队员 does not open it again.
    fireEvent.click(screen.getByText('团队'));
    rerender(<TeamView />);
    fireEvent.click(screen.getByText('队员'));
    rerender(<TeamView />);
    expect(screen.getByTestId('agents-section').getAttribute('data-trigger')).toBe('0');
    expect(editorOpens).toHaveBeenCalledTimes(1);
  });

  it('teams tab: two unnamed invalid members are numbered apart, with the reason as a caption', () => {
    settingsState.activeTeamTab = 'teams';
    seedAgent('分析师', { roleId: 'r-lead' });
    discoveryState.agents = [{ name: '分析师' }];
    useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead', 'role-a', 'role-b'], createdAt: 1 }] });
    render(<TeamView />);
    fireEvent.click(screen.getByTestId('team-row-数据小队'));
    const first = screen.getByTestId('team-member-invalid-role-a');
    const second = screen.getByTestId('team-member-invalid-role-b');
    expect(first.textContent).toContain('已失效成员 1');
    expect(second.textContent).toContain('已失效成员 2');
    for (const row of [first, second]) expect(row.textContent).toContain('专家已删除、修改，或所属插件已停用');
    // Same labels in the edit dialog.
    fireEvent.click(screen.getByTestId('team-detail-menu'));
    fireEvent.click(screen.getByTestId('team-detail-edit'));
    expect(screen.getByTestId('team-edit-invalid-role-a').textContent).toContain('已失效成员 1');
    expect(screen.getByTestId('team-edit-invalid-role-b').textContent).toContain('已失效成员 2');
    expect(screen.getByTestId('team-edit-invalid-role-b').textContent).toContain('专家已删除、修改，或所属插件已停用');
  });

  it('teams tab: an invalid member whose id carries a name is shown by that name', () => {
    settingsState.activeTeamTab = 'teams';
    seedAgent('分析师', { roleId: 'r-lead' });
    discoveryState.agents = [{ name: '分析师' }];
    useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead', 'plugin:x', 'role-a'], createdAt: 1 }] });
    render(<TeamView />);
    fireEvent.click(screen.getByTestId('team-row-数据小队'));
    expect(screen.getByTestId('team-member-invalid-plugin:x').textContent).toContain('「x」已失效');
    // Numbering counts only the unnamed ones.
    expect(screen.getByTestId('team-member-invalid-role-a').textContent).toContain('已失效成员 1');
    fireEvent.click(screen.getByTestId('team-detail-menu'));
    fireEvent.click(screen.getByTestId('team-detail-edit'));
    expect(screen.getByTestId('team-edit-invalid-plugin:x').textContent).toContain('「x」已失效');
  });

  it('team dialog: with an empty member pool an invalid member is still listed and removable', async () => {
    settingsState.activeTeamTab = 'teams';
    // No live agent at all: the leader and the member are both gone.
    useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'r-gone-lead', memberRoleIds: ['r-gone-lead', 'role-a'], createdAt: 1 }] });
    render(<TeamView />);
    fireEvent.click(screen.getByTestId('team-row-数据小队'));
    fireEvent.click(screen.getByTestId('team-detail-menu'));
    fireEvent.click(screen.getByTestId('team-detail-edit'));
    expect(screen.getByText('新建队员')).toBeTruthy();
    expect(screen.getByTestId('team-edit-invalid-role-a').textContent).toContain('已失效成员 1');
    fireEvent.click(screen.getByTestId('team-edit-invalid-remove-role-a'));
    expect(screen.queryByTestId('team-edit-invalid-role-a')).toBeNull();
    fireEvent.click(screen.getByTestId('team-save'));
    await waitFor(() => expect(useTeamStore.getState().teams[0].memberRoleIds).toEqual(['r-gone-lead']));
  });
});
