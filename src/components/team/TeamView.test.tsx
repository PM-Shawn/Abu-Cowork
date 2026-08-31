// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTeamStore } from '@/stores/teamStore';

// TeamView reads/writes the real teamStore (zustand works fine in tests);
// everything else is mocked at the boundary, mirroring ToolboxModal.test.tsx.

const settingsState = {
  activeTeamTab: 'tasks' as 'inbox' | 'tasks' | 'members' | 'teams' | 'pipelines',
  toolboxSearchQuery: '',
  setToolboxSearchQuery: vi.fn((value: string) => { settingsState.toolboxSearchQuery = value; }),
  disabledAgents: [] as string[],
  setActiveTeamTab: vi.fn((tab: 'inbox' | 'tasks' | 'members' | 'teams' | 'pipelines') => {
    settingsState.activeTeamTab = tab;
  }),
  closeTeam: vi.fn(),
};

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector?: (state: Record<string, unknown>) => unknown) =>
    selector ? selector(settingsState) : settingsState,
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    setPendingInput: vi.fn(),
    startNewConversation: vi.fn(),
  }),
}));

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
  runPipeline: vi.fn(async () => ({ ok: true, taskId: 'tk' })),
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

function seedAgent(name: string, roleId?: string) {
  const agent = { name, description: `${name} desc`, roleId, filePath: `/agents/${name}/AGENT.md`, systemPrompt: '' };
  registryAgents[name] = agent;
  return agent;
}

describe('TeamView', () => {
  beforeEach(() => {
    useTeamStore.setState({ teams: [], tasks: [], pipelines: [] });
    settingsState.activeTeamTab = 'tasks';
    for (const key of Object.keys(registryAgents)) delete registryAgents[key];
    discoveryState.agents = [];
    vi.clearAllMocks();
  });

  it('renders the four tabs in the pinned order 任务·收件箱·队员·团队', () => {
    render(<TeamView />);
    const tabs = screen.getAllByRole('button').map((b) => b.textContent).filter((label) =>
      ['收件箱', '任务', '队员', '团队'].includes(label ?? ''));
    expect(tabs).toEqual(['任务', '收件箱', '队员', '团队']);
  });

  it('shows the inbox empty state when nothing needs the user', () => {
    settingsState.activeTeamTab = 'inbox';
    render(<TeamView />);
    expect(screen.getByText('没有需要你处理的事')).toBeTruthy();
  });

  it('teams tab empty state offers creating a team; task tab without teams routes to teams first', () => {
    settingsState.activeTeamTab = 'teams';
    render(<TeamView />);
    expect(screen.getByText('还没有团队')).toBeTruthy();
    expect(screen.getAllByText('新建团队').length).toBeGreaterThan(0);
  });

  it('task empty state has no dead end: without a team it offers 先建一个团队', () => {
    settingsState.activeTeamTab = 'tasks';
    render(<TeamView />);
    expect(screen.getByText('先建一个团队')).toBeTruthy();
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

  it('task dialog: single team preselected, creates task into awaiting_plan', async () => {
    useTeamStore.setState({
      teams: [{ id: 'tm1', name: '数据小队', leaderRoleId: 'r1', memberRoleIds: ['r1'], createdAt: 1 }],
      tasks: [],
    });
    settingsState.activeTeamTab = 'tasks';
    render(<TeamView />);
    fireEvent.click(screen.getByText('新建任务'));
    fireEvent.change(screen.getByTestId('task-goal-input'), { target: { value: '出一版 8 月周报' } });
    fireEvent.click(screen.getByTestId('task-create'));
    await waitFor(() => expect(useTeamStore.getState().tasks).toHaveLength(1));
    expect(useTeamStore.getState().tasks[0].status).toBe('awaiting_plan');
  });

  it('pipelines tab: empty state, then a saved pipeline renders with a 运行 action', () => {
    settingsState.activeTeamTab = 'pipelines';
    const { unmount } = render(<TeamView />);
    expect(screen.getByText('还没有流水线')).toBeTruthy();
    unmount();
    useTeamStore.setState({
      teams: [{ id: 'tm1', name: '数据小队', leaderRoleId: 'r1', memberRoleIds: ['r1'], createdAt: 1 }],
      pipelines: [{
        id: 'pl1', teamId: 'tm1', name: '周报流水线', goal: '出周报',
        template: [{ id: '1', memberRoleId: 'r1', what: '写', dependsOn: [] }],
        doneWhen: [], createdFromTaskId: 'tk0', createdAt: 1, consecutiveFailures: 0,
      }],
    });
    render(<TeamView />);
    expect(screen.getByText('周报流水线')).toBeTruthy();
    expect(screen.getByText('运行')).toBeTruthy();
  });

  it('members tab renders the shared AgentsSection (single identity source)', () => {
    settingsState.activeTeamTab = 'members';
    render(<TeamView />);
    expect(screen.getByTestId('agents-section')).toBeTruthy();
  });
});
