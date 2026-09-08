// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  setPendingAgent: vi.fn(),
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
const dispatch = vi.fn();
vi.mock('@/core/agent/agentLoopRunner', () => ({ runAgentLoopDispatched: (...args: unknown[]) => dispatch(...args) }));

const discoveryState = { agents: [] as Array<{ name: string }>, refresh: vi.fn() };
vi.mock('@/stores/discoveryStore', () => ({
  useDiscoveryStore: (selector?: (state: Record<string, unknown>) => unknown) =>
    selector ? selector(discoveryState) : discoveryState,
}));

const addToast = vi.fn();
vi.mock('@/stores/toastStore', () => ({
  useToastStore: (selector: (state: Record<string, unknown>) => unknown) => selector({ addToast }),
}));

// Pin the real zh-CN copy (assertions below are the product copy the user reviews).
vi.mock('@/i18n', async () => {
  const { default: zhCN } = await import('@/i18n/locales/zh-CN');
  const actual = await vi.importActual<typeof import('@/i18n')>('@/i18n');
  return { format: actual.format, useI18n: () => ({ t: zhCN, locale: 'zh-CN' }) };
});

const registryAgents: Record<string, { name: string; description: string; roleId?: string; filePath: string; systemPrompt: string; managed?: boolean }> = {};
vi.mock('@/core/agent/registry', () => ({
  agentRegistry: {
    getAgent: (name: string) => registryAgents[name],
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
  effectiveRoleId: (agent: { roleId?: string; name: string }) => agent.roleId ?? `builtin:${agent.name}`,
  isBuiltinAgent: () => false,
  resolveRoleId: () => null,
}));

// AgentsSection drags in the whole toolbox world — stub it.
vi.mock('@/components/customize/AgentsSection', () => ({
  default: () => <div data-testid="agents-section" />,
}));

import TeamView from './TeamView';

function seedAgent(name: string, extra?: string | { roleId?: string; skills?: string[] }) {
  const { roleId, skills } = typeof extra === 'string' ? { roleId: extra, skills: undefined } : (extra ?? {});
  const agent = { name, description: `${name} desc`, roleId, skills, filePath: `/agents/${name}/AGENT.md`, systemPrompt: '' };
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
    vi.clearAllMocks();
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

  it('teams tab: the detail\'s primary action opens a conversation already pinned to the team', () => {
    settingsState.activeTeamTab = 'teams';
    useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'r1', memberRoleIds: ['r1'], createdAt: 1 }] });
    render(<TeamView />);
    fireEvent.click(screen.getByTestId('team-row-数据小队'));
    fireEvent.click(screen.getByTestId('team-detail-start-chat'));
    expect(chatState.createConversation).toHaveBeenCalledWith(null, { teamId: 't1' });
    expect(chatState.setPendingAgent).toHaveBeenCalledWith(null);
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

  it.each([
    ['teams', 'team-create-trigger', '/create-agent 帮我组建一个团队，我的需求是：'],
    ['members', 'member-create-trigger', '/create-agent 帮我创建一个队员，我的需求是：'],
  ] as const)('explicitly selects the creation skill from the %s entry', (tab, trigger, prompt) => {
    settingsState.activeTeamTab = tab;
    render(<TeamView />);
    fireEvent.click(screen.getByTestId(trigger));
    fireEvent.click(screen.getByText('使用阿布创建'));
    expect(chatState.startNewConversation).toHaveBeenCalledOnce();
    expect(chatState.setPendingInput).toHaveBeenCalledWith(prompt);
    expect(dispatch).not.toHaveBeenCalled();
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

    fireEvent.click(screen.getByTestId('avatar-option-users-blue'));

    fireEvent.click(save);
    await waitFor(() => expect(useTeamStore.getState().teams).toHaveLength(1));
    const team = useTeamStore.getState().teams[0];
    expect(team.name).toBe('数据小队');
    expect(team.leaderRoleId).toBe('role-new');
    expect(team.avatar).toBe('icon:users/blue');
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

  it('shows the description on the card and only populated display sections in detail', () => {
    settingsState.activeTeamTab = 'teams';
    useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'r1', memberRoleIds: ['r1'], createdAt: 1, description: '看数据的小队', intro: '我们负责取数和出图' }] });
    render(<TeamView />);
    expect(screen.getByTestId('team-row-数据小队')).toHaveTextContent('看数据的小队');
    fireEvent.click(screen.getByTestId('team-row-数据小队'));
    expect(screen.getByText('我们负责取数和出图')).toBeTruthy();
    expect(screen.getByText('开场白')).toBeTruthy();
    expect(screen.queryByText('擅长')).toBeNull();
    expect(screen.queryByText('推荐提问')).toBeNull();
  });

  it('prefills a fresh team conversation from a suggested question without sending', () => {
    settingsState.activeTeamTab = 'teams';
    useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'r1', memberRoleIds: ['r1'], createdAt: 1, expertise: ['取数', '出图'], samplePrompts: ['帮我看上季度销量'] }] });
    render(<TeamView />);
    fireEvent.click(screen.getByTestId('team-row-数据小队'));
    expect(screen.queryByText('开场白')).toBeNull();
    expect(screen.getByText('擅长')).toBeTruthy();
    expect(screen.getByText('取数')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '帮我看上季度销量' }));
    expect(chatState.createConversation).toHaveBeenCalledWith(null, { teamId: 't1' });
    expect(chatState.setPendingInput).toHaveBeenCalledWith('帮我看上季度销量');
    expect(settingsState.closeTeam).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
    expect(screen.queryByTestId('team-detail-start-chat')).toBeNull();
  });

  it('edits and clears optional display fields using the shared form controls', async () => {
    settingsState.activeTeamTab = 'teams';
    useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'r1', memberRoleIds: ['r1'], createdAt: 1, description: '旧介绍', intro: '旧开场白', expertise: ['旧擅长'], samplePrompts: ['旧问题'] }] });
    render(<TeamView />);
    fireEvent.click(screen.getByTestId('team-row-数据小队'));
    fireEvent.click(screen.getByTestId('team-detail-menu'));
    fireEvent.click(screen.getByTestId('team-detail-edit'));
    expect(screen.getByLabelText('开场白（可选）')).toHaveValue('旧开场白');
    fireEvent.change(screen.getByLabelText('介绍（可选）'), { target: { value: '新介绍' } });
    fireEvent.change(screen.getByLabelText('开场白（可选）'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('擅长（可选）'), { target: { value: ' 取数\n\n出图 ' } });
    fireEvent.change(screen.getByLabelText('推荐提问（可选）'), { target: { value: ' 问题一\n问题二 ' } });
    fireEvent.click(screen.getByTestId('team-save'));
    await waitFor(() => expect(useTeamStore.getState().teams[0]).toMatchObject({ description: '新介绍', intro: undefined, expertise: ['取数', '出图'], samplePrompts: ['问题一', '问题二'] }));
  });
});
