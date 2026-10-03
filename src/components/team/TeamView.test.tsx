// @vitest-environment happy-dom
import { clearAllComposerDrafts, readComposerDraft, WELCOME_COMPOSER_DRAFT_KEY } from '@/stores/composerDraftStore';
import type { ReactElement } from 'react';
import { act, fireEvent, render as renderBare, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ds/button';
import { DesignSystemProvider } from '@/components/ds/provider';
import { useTeamStore } from '@/stores/teamStore';
import { BUILTIN_TEAMS } from '@/core/team/builtinTeams';
import { DEFAULT_SOURCES, useExtensionSourceStore } from '@/stores/extensionSourceStore';

// TeamView reads/writes the real teamStore (zustand works fine in tests);
// everything else is mocked at the boundary, mirroring ToolboxModal.test.tsx.

// The team dialog's avatar picker uses a design-system tooltip, so the page renders inside the provider like the app does.
const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

// The page takes no props and reads the settings store one field at a time, so the stand-in
// tells its readers when the tab changes, as the real store does.
const settingsListeners = new Set<() => void>();
const settingsState = {
  activeTeamTab: 'tasks' as 'inbox' | 'tasks' | 'members' | 'teams',
  toolboxSearchQuery: '',
  setToolboxSearchQuery: vi.fn((value: string) => { settingsState.toolboxSearchQuery = value; }),
  disabledAgents: [] as string[],
  setActiveTeamTab: vi.fn((tab: 'inbox' | 'tasks' | 'members' | 'teams') => {
    settingsState.activeTeamTab = tab;
    settingsListeners.forEach((listener) => listener());
  }),
  closeTeam: vi.fn(),
};

const enterpriseState = vi.hoisted(() => ({
  mode: { kind: 'personal' } as Record<string, unknown>,
  hasAgentMarket: false,
}));

vi.mock('@/stores/settingsStore', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (listener: () => void) => {
    settingsListeners.add(listener);
    return () => { settingsListeners.delete(listener); };
  };
  return {
    useSettingsStore: (selector?: (state: Record<string, unknown>) => unknown) =>
      useSyncExternalStore(subscribe, () => (selector ? selector(settingsState) : settingsState)),
  };
});

vi.mock('@/stores/enterpriseStore', () => ({
  useEnterpriseStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector({ mode: enterpriseState.mode }),
    { subscribe: () => () => {}, getState: () => ({ mode: enterpriseState.mode }) },
  ),
}));

vi.mock('@/core/enterprise/mounts-registry', () => ({
  getEnterpriseMount: (key: string) => key === 'agentMarket' && enterpriseState.hasAgentMarket
    ? ({ searchQuery, onClose }: { searchQuery?: string; onClose?: () => void }) => (
      <div data-testid="organization-agents" data-query={searchQuery}>
        <Button onClick={onClose}>Open organization expert</Button>
      </div>
    )
    : undefined,
}));

const chatState = {
  setPendingInput: vi.fn(),
  setPendingAgent: vi.fn(),
  setPendingTeamId: vi.fn(),
  setPendingExpertContact: vi.fn(),
  expertContactReceipts: {}, pendingReferences: [], pendingAttachmentRequests: [],
  startNewConversation: vi.fn(),
  switchConversation: vi.fn(),
  createConversation: vi.fn(() => 'c-new'),
  conversationIndex: {} as Record<string, { id: string; title: string; updatedAt: number; teamId?: string; workspacePath?: string | null }>,
};
vi.mock('@/stores/chatStore', () => ({
  useChatStore: Object.assign((selector: (state: Record<string, unknown>) => unknown) => selector(chatState), { getState: () => chatState }),
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

// Reactive stand-in for the plugin store: `activationReady`, plus the installed
// list a plugin team's badge and origin note name the plugin from.
vi.mock('@/stores/pluginStore', async () => {
  const { create } = await import('zustand');
  return { usePluginStore: create(() => ({ activationReady: true, installed: [] })) };
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
// Called each time the stub renders: the page renders it on every render of its own.
const sectionRenders = vi.fn();
vi.mock('@/components/customize/AgentsSection', async () => {
  const { useEffect } = await import('react');
  return {
    default: function AgentsSectionStub({ manualCreateTrigger }: { manualCreateTrigger?: number }) {
      sectionRenders();
      useEffect(() => {
        if (manualCreateTrigger && manualCreateTrigger > 0) editorOpens();
      }, [manualCreateTrigger]);
      return <div data-testid="agents-section" data-trigger={String(manualCreateTrigger ?? 0)} />;
    },
  };
});

// How many times each team card has rendered, by the id of its item.
const cardRenders = vi.hoisted(() => ({ byId: {} as Record<string, number> }));
vi.mock('@/components/toolbox/ToolCard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/toolbox/ToolCard')>();
  return {
    ...actual,
    default: (props: Parameters<typeof actual.default>[0]) => {
      cardRenders.byId[props.item.id] = (cardRenders.byId[props.item.id] ?? 0) + 1;
      return actual.default(props);
    },
  };
});

// The app the shell shows: the general shell unless a test puts the page inside an app.
const appState = vi.hoisted(() => ({ selected: null as unknown }));
vi.mock('@/stores/appStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/appStore')>();
  return {
    ...actual,
    useSelectedApp: () => {
      const general = actual.useSelectedApp();
      return (appState.selected as typeof general | null) ?? general;
    },
  };
});

import TeamView from './TeamView';

// Looked up by id, not by position: the shelf order is product copy, not a contract.
const SOFTWARE_RD_TEAM = BUILTIN_TEAMS.find((team) => team.id === 'builtin-team:software-rd')!;

type SeedExtra = { roleId?: string; skills?: string[]; source?: { kind: 'plugin'; plugin: string } };
function seedAgent(name: string, extra?: string | SeedExtra) {
  const { roleId, skills, source } = typeof extra === 'string' ? ({ roleId: extra } as SeedExtra) : (extra ?? {});
  const agent = { name, description: `${name} desc`, roleId, skills, source, filePath: `/agents/${name}/AGENT.md`, systemPrompt: '' };
  registryAgents[name] = agent;
  return agent;
}

// How the tests reach the page's controls. Kept in one place so the assertions below read the same
// whatever the controls are made of.
const card = (name: string) => screen.getByTestId(`team-row-${name}`);
/** Opens the team's window from its card, the way a key press on the card does: the card has the focus. */
function openDetail(name: string) {
  card(name).focus();
  fireEvent.click(card(name));
}
/** Chooses an entry of the open window's 「…」 menu. What the entry does runs once the menu has gone. */
async function chooseInDetail(entry: 'team-detail-edit' | 'team-detail-delete') {
  await userEvent.click(screen.getByTestId('team-detail-menu'));
  fireEvent.click(await screen.findByTestId(entry));
}
async function askToDeleteTeam(name: string) {
  openDetail(name);
  await chooseInDetail('team-detail-delete');
  return screen.findByRole('alertdialog');
}
async function answerDelete() {
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '删除' }));
}
/** From the open window: 「…」 → 编辑. The edit window takes the place of the detail window. */
async function editFromDetail() {
  await chooseInDetail('team-detail-edit');
  await screen.findByTestId('team-name-input');
}
async function openTeamEditor(name: string) {
  openDetail(name);
  await editFromDetail();
}
const leaderBox = () => screen.getByRole('combobox', { name: '队长' });
const membersBox = () => screen.getByRole('combobox', { name: '成员' });
async function pickLeader(name: string) {
  await userEvent.click(leaderBox());
  fireEvent.click(await screen.findByRole('option', { name }));
}
async function pickMembers(names: string[]) {
  await userEvent.click(membersBox());
  for (const name of names) fireEvent.click(await screen.findByRole('option', { name }));
  // The list stays open after a choice; Escape closes it alone.
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
}
/** The first line of each option of the open list: its name, without its description. */
async function leaderOptionNames(): Promise<string[]> {
  await userEvent.click(leaderBox());
  const options = await screen.findAllByRole('option');
  return options.map((option) => option.querySelector('span.truncate')!.textContent ?? '');
}

// happy-dom reports no animation, so Radix removes a closed layer at once. With this, a closed
// layer has an exit animation: it stays on the page, as it does in the app while it fades out.
function keepClosingLayersOnScreen() {
  const real = window.getComputedStyle.bind(window);
  return vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) => {
    const styles = real(element, pseudo);
    return new Proxy(styles, {
      get(target, prop) {
        if (prop === 'animationName') return element.getAttribute('data-state') === 'closed' ? 'exit' : 'enter';
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
}
const closingWindow = () => document.querySelector<HTMLElement>('[role="dialog"][data-state="closed"]')!;
// Ends the fade of a closed layer: it leaves the page, and what it does once it has gone runs (one timer tick later).
function endFade(layer: HTMLElement) {
  vi.useFakeTimers();
  try {
    const ended = new Event('animationend', { bubbles: true });
    Object.defineProperty(ended, 'animationName', { value: 'exit' });
    act(() => { layer.dispatchEvent(ended); });
    act(() => { vi.runOnlyPendingTimers(); });
  } finally {
    vi.useRealTimers();
  }
}
const finishClosing = () => endFade(closingWindow());
/** The page's 「添加」 → 手动创建: a blank window for a new team. */
async function openNewTeam() {
  await userEvent.click(screen.getByTestId('team-create-trigger'));
  fireEvent.click(await screen.findByRole('menuitem', { name: '手动创建' }));
  await screen.findByTestId('team-name-input');
}

describe('TeamView', () => {
  beforeEach(() => {
    clearAllComposerDrafts();
    useTeamStore.setState({ teams: [], managedTeamSources: {} });
    // Every team seeded below is one the user assembled, so these assertions
    // are about the 「我的」 shelf; 市场 (the default) holds the built-in teams.
    useExtensionSourceStore.setState({ sources: { ...DEFAULT_SOURCES, members: 'mine', teams: 'mine' } });
    settingsState.activeTeamTab = 'members';
    settingsState.disabledAgents = [];
    for (const key of Object.keys(registryAgents)) delete registryAgents[key];
    discoveryState.agents = [];
    chatState.conversationIndex = {};
    usePluginStore.setState({ activationReady: true });
    localeRef.current = 'zh-CN';
    enterpriseState.mode = { kind: 'personal' };
    enterpriseState.hasAgentMarket = false;
    appState.selected = null;
    cardRenders.byId = {};
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it('team dialog: opened before plugin records are ready, it re-seeds once they are — real members back in the picker', async () => {
    usePluginStore.setState({ activationReady: false });
    settingsState.activeTeamTab = 'teams';
    seedAgent('分析师', { roleId: 'r-lead' });
    seedAgent('校对', { roleId: 'r-mem' });
    discoveryState.agents = [{ name: '分析师' }, { name: '校对' }];
    useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead', 'r-mem'], createdAt: 1 }] });
    render(<TeamView />);
    await openTeamEditor('数据小队');
    expect(screen.getByTestId('team-edit-invalid-r-mem')).toBeTruthy();

    act(() => { usePluginStore.setState({ activationReady: true }); });

    expect(screen.queryByTestId('team-edit-invalid-r-mem')).toBeNull();
    expect(screen.getByTestId('team-members-select').textContent).toContain('校对');
    expect(screen.getByTestId('team-leader-select').textContent).toContain('分析师');
  });

  it('team dialog: a later ready→not-ready blip (a plugin install) does not wipe what the user typed', async () => {
    settingsState.activeTeamTab = 'teams';
    seedAgent('分析师', { roleId: 'r-lead' });
    discoveryState.agents = [{ name: '分析师' }];
    useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead'], createdAt: 1 }] });
    render(<TeamView />);
    await openTeamEditor('数据小队');
    fireEvent.change(screen.getByTestId('team-name-input'), { target: { value: '新名字' } });

    act(() => { usePluginStore.setState({ activationReady: false }); });
    act(() => { usePluginStore.setState({ activationReady: true }); });

    expect((screen.getByTestId('team-name-input') as HTMLInputElement).value).toBe('新名字');
  });

  it('team dialog: renaming onto another team\u2019s name is refused before it can be saved', async () => {
    settingsState.activeTeamTab = 'teams';
    seedAgent('\u5206\u6790\u5e08', { roleId: 'r-lead' });
    discoveryState.agents = [{ name: '\u5206\u6790\u5e08' }];
    useTeamStore.setState({ teams: [
      { id: 't1', name: '\u6570\u636e\u5c0f\u961f', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead'], createdAt: 1 },
      { id: 't2', name: '\u589e\u957f\u5c0f\u961f', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead'], createdAt: 2 },
    ] });
    render(<TeamView />);
    await openTeamEditor('\u589e\u957f\u5c0f\u961f');
    // Its own name is fine — re-saving a dialog untouched must not be blocked.
    expect(screen.queryByTestId('team-name-taken')).toBeNull();
    expect((screen.getByTestId('team-save') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.change(screen.getByTestId('team-name-input'), { target: { value: '\u6570\u636e\u5c0f\u961f' } });
    expect(screen.getByTestId('team-name-taken')).toBeTruthy();
    expect((screen.getByTestId('team-save') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId('team-name-input'), { target: { value: '\u589e\u957f\u5c0f\u961f 2' } });
    expect(screen.queryByTestId('team-name-taken')).toBeNull();
    expect((screen.getByTestId('team-save') as HTMLButtonElement).disabled).toBe(false);
  });

  it('renders the two tabs 专家·专家团 (the task board is gone)', () => {
    render(<TeamView />);
    const tabs = screen.getAllByRole('button').map((b) => b.textContent).filter((label) =>
      ['收件箱', '任务', '专家', '专家团'].includes(label ?? ''));
    expect(tabs).toEqual(['专家', '专家团']);
  });

  it('teams tab: the header search filters the teams and says when nothing matches', () => {
    settingsState.activeTeamTab = 'teams';
    useTeamStore.setState({ teams: [
      { id: 't1', name: '数据小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead'], createdAt: 1 },
      { id: 't2', name: '增长小队', description: '拉新和留存', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead'], createdAt: 2 },
    ] });
    render(<TeamView />);
    const search = screen.getByPlaceholderText('搜索...');

    fireEvent.change(search, { target: { value: '留存' } });
    expect(screen.queryByTestId('team-row-数据小队')).toBeNull();
    expect(screen.getByTestId('team-row-增长小队')).toBeTruthy();

    fireEvent.change(search, { target: { value: '不存在的团' } });
    expect(screen.getByText('未找到专家团')).toBeTruthy();
  });

  it('teams tab empty state offers creating a team', () => {
    settingsState.activeTeamTab = 'teams';
    render(<TeamView />);
    expect(screen.getByText('还没有专家团')).toBeTruthy();
    expect(screen.getAllByText('新建专家团').length).toBeGreaterThan(0);
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

  it('teams tab: a team that picked no icon keeps a visible grey plate on its card', () => {
    // Same reason as the expert card: the avatar fills the 40px slot, so the
    // avatar itself paints the plate the group mark sits on: the neutral fill,
    // which shows on the card's surface. No identity colour replaces it.
    settingsState.activeTeamTab = 'teams';
    seedAgent('分析师', { roleId: 'r-lead' });
    discoveryState.agents = [{ name: '分析师' }];
    useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead'], createdAt: 1 }] });
    render(<TeamView />);
    const avatar = screen.getByTestId('team-row-数据小队').querySelector('[data-testid="team-avatar"]')!;
    expect(avatar).toHaveClass('size-10');
    expect(avatar).toHaveClass('bg-fill');
    expect(avatar).not.toHaveAttribute('style');
  });

  it('teams tab: the opened detail keeps that grey plate too', () => {
    // The detail header's plate is the 56px slot, and a `2xl` avatar covers it
    // exactly, so the avatar paints the plate there too. The card's avatar stays
    // in the DOM behind the window, so pick the one inside the window.
    settingsState.activeTeamTab = 'teams';
    seedAgent('分析师', { roleId: 'r-lead' });
    discoveryState.agents = [{ name: '分析师' }];
    useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead'], createdAt: 1 }] });
    render(<TeamView />);
    fireEvent.click(screen.getByTestId('team-row-数据小队'));
    const avatar = within(screen.getByRole('dialog', { name: '数据小队' })).getByTestId('team-avatar');
    expect(avatar).toHaveClass('size-14');
    expect(avatar).toHaveClass('bg-fill');
    expect(avatar).not.toHaveAttribute('style');
  });

  it('shows why an unavailable organization team cannot start', () => {
    settingsState.activeTeamTab = 'teams';
    // A bound client's 「市场」 is the organization's teams — the shelf the
    // view already opens on.
    enterpriseState.mode = {
      kind: 'enterprise',
      binding: { serverUrl: 'https://enterprise.example' },
      config: null,
    };
    useExtensionSourceStore.setState({ sources: { ...DEFAULT_SOURCES } });
    seedAgent('分析师', { roleId: 'r-lead' });
    discoveryState.agents = [{ name: '分析师' }];
    useTeamStore.getState().registerManagedTeamSource('enterprise', () => true);
    useTeamStore.getState().replaceManagedTeams('enterprise', [{
      id: 'org-team',
      name: '组织数据小队',
      leaderRoleId: 'r-lead',
      memberRoleIds: ['r-lead'],
      createdAt: 1,
      managed: {
        source: 'enterprise',
        id: 'org-team',
        version: '1',
        readOnly: true,
        ready: false,
        unavailableReason: '成员不可用：分析师',
      },
    }]);
    render(<TeamView />);
    fireEvent.click(screen.getByTestId('team-row-组织数据小队'));

    expect(screen.getByTestId('team-managed-unavailable')).toHaveTextContent('成员不可用：分析师');
    expect(screen.getByTestId('team-detail-start-chat')).toBeDisabled();
    expect(screen.queryByTestId('team-detail-menu')).toBeNull();
  });

  it('teams tab: a bound client\'s 市场 lists only the organization\'s teams and has nothing to add', () => {
    settingsState.activeTeamTab = 'teams';
    enterpriseState.mode = {
      kind: 'enterprise',
      binding: { serverUrl: 'https://enterprise.example' },
      config: null,
    };
    useExtensionSourceStore.setState({ sources: { ...DEFAULT_SOURCES } });
    seedAgent('分析师', { roleId: 'r-lead' });
    discoveryState.agents = [{ name: '分析师' }];
    useTeamStore.setState({ teams: [
      ...useTeamStore.getState().teams,
      { id: 't-mine', name: '我的小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead'], createdAt: 2 },
    ] });
    useTeamStore.getState().registerManagedTeamSource('enterprise', () => true);
    useTeamStore.getState().replaceManagedTeams('enterprise', [{
      id: 'org-team',
      name: '组织数据小队',
      leaderRoleId: 'r-lead',
      memberRoleIds: ['r-lead'],
      createdAt: 1,
      managed: { source: 'enterprise', id: 'org-team', version: '1', readOnly: true, ready: true },
    }]);
    render(<TeamView />);

    expect(screen.getByTestId('team-row-组织数据小队')).toBeTruthy();
    expect(screen.queryByTestId('team-row-我的小队')).toBeNull();
    expect(screen.queryAllByTestId(/^team-row-/)).toHaveLength(1);
    expect(screen.queryByTestId('team-create-trigger')).toBeNull();

    fireEvent.click(screen.getByTestId('team-source-mine'));
    expect(screen.getByTestId('team-row-我的小队')).toBeTruthy();
    expect(screen.queryByTestId('team-row-组织数据小队')).toBeNull();
    expect(screen.getByTestId('team-create-trigger')).toBeVisible();
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

  it('teams tab: a plugin team lists an invalid member without offering to remove it', () => {
    // The plugin owns its roster, and updateTeam keeps read-only teams as they
    // are, so a 移除 here would do nothing.
    settingsState.activeTeamTab = 'teams';
    seedAgent('分析师', { roleId: 'r-lead' });
    discoveryState.agents = [{ name: '分析师' }];
    useTeamStore.setState({ teams: [{ id: 'plugin-team:shop@market/crew', name: '店铺小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead', 'r-gone'], createdAt: 1 }] });
    render(<TeamView />);
    fireEvent.click(screen.getByTestId('team-row-店铺小队'));
    expect(screen.getByTestId('team-member-invalid-r-gone').textContent).toContain('已失效');
    expect(screen.queryByText('移除')).toBeNull();
  });

  it('team dialog: an invalid member is listed, kept on save unless removed', async () => {
    settingsState.activeTeamTab = 'teams';
    seedAgent('分析师', { roleId: 'r-lead' });
    discoveryState.agents = [{ name: '分析师' }];
    useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead', 'r-gone'], createdAt: 1 }] });
    render(<TeamView />);
    await openTeamEditor('数据小队');
    expect(screen.getByTestId('team-edit-invalid-r-gone')).toBeTruthy();
    // Save without touching it: the ghost is preserved (never silently dropped).
    fireEvent.click(screen.getByTestId('team-save'));
    await waitFor(() => expect(useTeamStore.getState().teams[0].memberRoleIds).toEqual(['r-lead', 'r-gone']));
    await waitFor(() => expect(screen.queryByTestId('team-name-input')).toBeNull());
    // Reopen, remove, save: now it is gone.
    await openTeamEditor('数据小队');
    fireEvent.click(screen.getByTestId('team-edit-invalid-remove-r-gone'));
    expect(screen.queryByTestId('team-edit-invalid-r-gone')).toBeNull();
    fireEvent.click(screen.getByTestId('team-save'));
    await waitFor(() => expect(useTeamStore.getState().teams[0].memberRoleIds).toEqual(['r-lead']));
  });

  it('team dialog: a plugin member stored under its legacy role- id stays in the picker', async () => {
    // Teams saved before plugin agents got synthetic `plugin:<name>` ids hold
    // the frontmatter `role-…` id. It must still resolve to the picker chip —
    // otherwise the member silently drops out and can be re-added as a duplicate.
    settingsState.activeTeamTab = 'teams';
    seedAgent('分析师', { roleId: 'r-lead' });
    seedAgent('校对', { roleId: 'role-legacy', source: { kind: 'plugin', plugin: 'x@official' } });
    discoveryState.agents = [{ name: '分析师' }, { name: '校对' }];
    useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead', 'role-legacy'], createdAt: 1 }] });
    render(<TeamView />);
    await openTeamEditor('数据小队');
    expect(screen.getByTestId('team-members-select').textContent).toContain('校对');
    expect(screen.queryByTestId('team-edit-invalid-role-legacy')).toBeNull();
  });

  it('teams tab: the detail\'s primary action opens a conversation already pinned to the team', () => {
    settingsState.activeTeamTab = 'teams';
    useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'r1', memberRoleIds: ['r1'], createdAt: 1 }] });
    render(<TeamView />);
    fireEvent.click(screen.getByTestId('team-row-数据小队'));
    fireEvent.click(screen.getByTestId('team-detail-start-chat'));
    expect(chatState.createConversation).not.toHaveBeenCalled();
    expect(chatState.startNewConversation).toHaveBeenCalled();
    expect(chatState.setPendingTeamId).toHaveBeenCalledWith('t1');
    expect(chatState.setPendingAgent).toHaveBeenCalledWith(null);
    // Nothing prefilled: the user says what they want in their own words.
    expect(chatState.setPendingInput).toHaveBeenCalledWith(null);
    expect(readComposerDraft(WELCOME_COMPOSER_DRAFT_KEY).text).toBe('');
  });

  it('teams tab: 编辑 lives behind the detail\'s "…" menu, mirroring the 专家 detail', async () => {
    settingsState.activeTeamTab = 'teams';
    useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'r1', memberRoleIds: ['r1'], createdAt: 1 }] });
    render(<TeamView />);
    await openTeamEditor('数据小队');
    expect(screen.getByTestId('team-name-input')).toBeTruthy();
  });

  it('teams tab: creating offers 使用阿布创建 alongside 手动创建 (parity with 专家)', async () => {
    settingsState.activeTeamTab = 'teams';
    render(<TeamView />);
    await userEvent.click(screen.getByTestId('team-create-trigger'));
    const menu = screen.getByTestId('team-create-menu');
    expect(menu.textContent).toContain('使用阿布创建');
    expect(menu.textContent).toContain('手动创建');
  });

  it.each([
    ['teams', 'team-create-trigger', '/create-agent 帮我组建一个专家团，我的需求是：'],
    ['members', 'member-create-trigger', '/create-agent 帮我创建一个专家，我的需求是：'],
  ] as const)('explicitly selects the creation skill from the %s entry', async (tab, trigger, prompt) => {
    settingsState.activeTeamTab = tab;
    render(<TeamView />);
    await userEvent.click(screen.getByTestId(trigger));
    fireEvent.click(screen.getByText('使用阿布创建'));
    // The chosen entry runs once the menu has gone.
    await waitFor(() => expect(chatState.startNewConversation).toHaveBeenCalledOnce());
    expect(chatState.setPendingInput).toHaveBeenCalledWith(prompt, { startsTask: true });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('team dialog: create button stays disabled until name + leader are set', async () => {
    seedAgent('writer');
    discoveryState.agents = [{ name: 'writer' }];
    settingsState.activeTeamTab = 'teams';
    render(<TeamView />);
    fireEvent.click(screen.getAllByText('新建专家团')[0]);
    const save = screen.getByTestId('team-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByTestId('team-name-input'), { target: { value: '数据小队' } });
    expect(save.disabled).toBe(true); // still no leader

    // Leader is its own searchable dropdown (user feedback 2026-08-31).
    await pickLeader('writer');
    expect(save.disabled).toBe(false);

    fireEvent.click(screen.getByTestId('avatar-picker-trigger'));
    fireEvent.click(screen.getByTestId('avatar-icon-users'));

    fireEvent.click(save);
    await waitFor(() => expect(useTeamStore.getState().teams).toHaveLength(1));
    const team = useTeamStore.getState().teams[0];
    expect(team.name).toBe('数据小队');
    expect(team.leaderRoleId).toBe('role-new');
    expect(team.avatar).toBe('icon:users/blue');
    expect(addToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('team dialog with zero agents offers 新建专家 instead of a dead end', () => {
    settingsState.activeTeamTab = 'teams';
    render(<TeamView />);
    fireEvent.click(screen.getAllByText('新建专家团')[0]);
    expect(screen.getByText('新建专家')).toBeTruthy();
  });

  it('members tab renders the shared AgentsSection (single identity source)', () => {
    settingsState.activeTeamTab = 'members';
    render(<TeamView />);
    expect(screen.getByTestId('agents-section')).toBeTruthy();
  });

  // A bound client's 「市场」 is the organization's catalog on every surface —
  // skills, connectors, plugins, and experts alike. 「我的」 stays this user's.
  it('members tab: a bound enterprise client gets the organization catalog on 市场', () => {
    enterpriseState.mode = {
      kind: 'enterprise',
      binding: { serverUrl: 'https://enterprise.example' },
      config: null,
    };
    enterpriseState.hasAgentMarket = true;
    useExtensionSourceStore.setState({ sources: { ...DEFAULT_SOURCES } });
    render(<TeamView />);

    expect(screen.queryByTestId('team-source-organization')).toBeNull();
    expect(screen.getByTestId('organization-agents')).toBeVisible();
    expect(screen.queryByTestId('agents-section')).toBeNull();
    expect(screen.queryByTestId('member-create-trigger')).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('搜索...'), { target: { value: '审阅' } });
    expect(screen.getByTestId('organization-agents')).toHaveAttribute('data-query', '审阅');
    fireEvent.click(screen.getByRole('button', { name: 'Open organization expert' }));
    expect(settingsState.closeTeam).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('team-source-mine'));
    expect(screen.getByTestId('agents-section')).toBeVisible();
    expect(screen.getByTestId('member-create-trigger')).toBeVisible();
  });

  // An unbound client keeps Abu's own shelf under the same name.
  it('members tab: an unbound client gets Abu’s own experts on 市场', () => {
    useExtensionSourceStore.setState({ sources: { ...DEFAULT_SOURCES } });
    render(<TeamView />);
    expect(screen.queryByTestId('organization-agents')).toBeNull();
    expect(screen.getByTestId('agents-section')).toBeVisible();
  });

  it('members tab: leaving and coming back does not replay 手动创建 (no blank editor on return)', async () => {
    settingsState.activeTeamTab = 'members';
    render(<TeamView />);
    await userEvent.click(screen.getByTestId('member-create-trigger'));
    fireEvent.click(screen.getByText('手动创建'));
    // The chosen entry runs once the menu has gone.
    await waitFor(() => expect(screen.getByTestId('agents-section').getAttribute('data-trigger')).toBe('1'));
    expect(editorOpens).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('专家团'));
    expect(screen.queryByTestId('agents-section')).toBeNull();
    fireEvent.click(screen.getByText('专家'));
    expect(screen.getByTestId('agents-section').getAttribute('data-trigger')).toBe('0');
    expect(editorOpens).toHaveBeenCalledTimes(1);
  });

  it('team dialog: 新建专家 switches to 专家 and opens the blank editor exactly once', () => {
    // The tab switch and the trigger bump land in one commit: the section mounts
    // with the bumped value and opens the editor before the tab-change reset runs.
    settingsState.activeTeamTab = 'teams';
    render(<TeamView />);
    fireEvent.click(screen.getAllByText('新建专家团')[0]);
    fireEvent.click(screen.getByText('新建专家'));
    expect(screen.getByTestId('agents-section')).toBeTruthy();
    expect(editorOpens).toHaveBeenCalledTimes(1);
    // …and the reset means a later return to 专家 does not open it again.
    fireEvent.click(screen.getByText('专家团'));
    expect(screen.queryByTestId('agents-section')).toBeNull();
    fireEvent.click(screen.getByText('专家'));
    expect(screen.getByTestId('agents-section').getAttribute('data-trigger')).toBe('0');
    expect(editorOpens).toHaveBeenCalledTimes(1);
  });

  it('teams tab: two unnamed invalid members are numbered apart, with the reason as a caption', async () => {
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
    await editFromDetail();
    expect(screen.getByTestId('team-edit-invalid-role-a').textContent).toContain('已失效成员 1');
    expect(screen.getByTestId('team-edit-invalid-role-b').textContent).toContain('已失效成员 2');
    expect(screen.getByTestId('team-edit-invalid-role-b').textContent).toContain('专家已删除、修改，或所属插件已停用');
  });

  it('teams tab: an invalid member whose id carries a name is shown by that name', async () => {
    settingsState.activeTeamTab = 'teams';
    seedAgent('分析师', { roleId: 'r-lead' });
    discoveryState.agents = [{ name: '分析师' }];
    useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead', 'plugin:x', 'role-a'], createdAt: 1 }] });
    render(<TeamView />);
    fireEvent.click(screen.getByTestId('team-row-数据小队'));
    expect(screen.getByTestId('team-member-invalid-plugin:x').textContent).toContain('「x」已失效');
    // Numbering counts only the unnamed ones.
    expect(screen.getByTestId('team-member-invalid-role-a').textContent).toContain('已失效成员 1');
    await editFromDetail();
    expect(screen.getByTestId('team-edit-invalid-plugin:x').textContent).toContain('「x」已失效');
  });

  it('team dialog: with an empty member pool an invalid member is still listed and removable', async () => {
    settingsState.activeTeamTab = 'teams';
    // No live agent at all: the leader and the member are both gone.
    useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'r-gone-lead', memberRoleIds: ['r-gone-lead', 'role-a'], createdAt: 1 }] });
    render(<TeamView />);
    await openTeamEditor('数据小队');
    expect(screen.getByText('新建专家')).toBeTruthy();
    expect(screen.getByTestId('team-edit-invalid-role-a').textContent).toContain('已失效成员 1');
    fireEvent.click(screen.getByTestId('team-edit-invalid-remove-role-a'));
    expect(screen.queryByTestId('team-edit-invalid-role-a')).toBeNull();
    fireEvent.click(screen.getByTestId('team-save'));
    await waitFor(() => expect(useTeamStore.getState().teams[0].memberRoleIds).toEqual(['r-gone-lead']));
  });

  it('shows the description on the card and only populated display sections in detail', () => {
    settingsState.activeTeamTab = 'teams';
    useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'r1', memberRoleIds: ['r1'], createdAt: 1, description: '看数据的小队', intro: '我们负责取数和出图' }] });
    render(<TeamView />);
    expect(screen.getByTestId('team-row-数据小队')).toHaveTextContent('看数据的小队');
    fireEvent.click(screen.getByTestId('team-row-数据小队'));
    // The card summary and the detail subtitle both carry the description.
    expect(screen.getAllByText('看数据的小队', { exact: true })).toHaveLength(2);
    // The greeting is first-contact only — the detail no longer repeats it.
    expect(screen.queryByText('我们负责取数和出图')).toBeNull();
    expect(screen.queryByText('开场白')).toBeNull();
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
    expect(chatState.createConversation).not.toHaveBeenCalled();
    expect(chatState.startNewConversation).toHaveBeenCalled();
    expect(chatState.setPendingTeamId).toHaveBeenCalledWith('t1');
    expect(chatState.setPendingInput).toHaveBeenCalledWith(null);
    expect(readComposerDraft(WELCOME_COMPOSER_DRAFT_KEY).text).toBe('帮我看上季度销量');
    expect(settingsState.closeTeam).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
    expect(screen.queryByTestId('team-detail-start-chat')).toBeNull();
  });

  it('edits and clears optional display fields using the shared form controls', async () => {
    settingsState.activeTeamTab = 'teams';
    useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'r1', memberRoleIds: ['r1'], createdAt: 1, description: '旧介绍', intro: '旧开场白', expertise: ['旧擅长'], samplePrompts: ['旧问题'] }] });
    render(<TeamView />);
    await openTeamEditor('数据小队');
    expect(screen.getByLabelText('开场白（可选）')).toHaveValue('旧开场白');
    fireEvent.change(screen.getByLabelText('介绍（可选）'), { target: { value: '新介绍' } });
    fireEvent.change(screen.getByLabelText('开场白（可选）'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('擅长（可选）'), { target: { value: ' 取数\n\n出图 ' } });
    fireEvent.change(screen.getByLabelText('推荐提问（可选）'), { target: { value: ' 问题一\n问题二 ' } });
    fireEvent.click(screen.getByTestId('team-save'));
    await waitFor(() => expect(useTeamStore.getState().teams[0]).toMatchObject({ description: '新介绍', intro: undefined, expertise: ['取数', '出图'], samplePrompts: ['问题一', '问题二'] }));
  });

  // What the page does to the team store and to the member list. Pinned before the page moved
  // onto the design system: the calls, their arguments and their conditions stay as they were.
  describe('the calls behind the page', () => {
    beforeEach(() => {
      settingsState.activeTeamTab = 'teams';
    });

    it('deletes exactly the team whose detail is open, and only after the confirmation', async () => {
      useTeamStore.setState({ teams: [
        { id: 't1', name: '数据小队', leaderRoleId: 'r1', memberRoleIds: ['r1'], createdAt: 1 },
        { id: 't2', name: '增长小队', leaderRoleId: 'r1', memberRoleIds: ['r1'], createdAt: 2 },
      ] });
      const deleteTeam = vi.spyOn(useTeamStore.getState(), 'deleteTeam');
      render(<TeamView />);
      await askToDeleteTeam('数据小队');
      expect(deleteTeam).not.toHaveBeenCalled();
      await answerDelete();
      expect(deleteTeam).toHaveBeenCalledTimes(1);
      expect(deleteTeam).toHaveBeenCalledWith('t1');
      expect(useTeamStore.getState().teams.map((team) => team.id)).toEqual(['t2']);
    });

    it('keeps the team when the confirmation is cancelled', async () => {
      useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'r1', memberRoleIds: ['r1'], createdAt: 1 }] });
      const deleteTeam = vi.spyOn(useTeamStore.getState(), 'deleteTeam');
      render(<TeamView />);
      const question = await askToDeleteTeam('数据小队');
      fireEvent.click(within(question).getByRole('button', { name: '取消' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(deleteTeam).not.toHaveBeenCalled();
      expect(useTeamStore.getState().teams).toHaveLength(1);
      // The team's window is still there.
      expect(screen.getByRole('dialog', { name: '数据小队' })).toBeInTheDocument();
    });

    it('saves an edit with the hidden and the invalid members still in the list, before the picked ones', async () => {
      seedAgent('分析师', { roleId: 'r-lead' });
      seedAgent('校对', { roleId: 'r-mem' });
      // A managed expert is a real member the picker does not offer.
      registryAgents['组织审阅'] = { name: '组织审阅', description: '', roleId: 'r-hidden', filePath: '/agents/org/AGENT.md', systemPrompt: '', managed: true };
      discoveryState.agents = [{ name: '分析师' }, { name: '校对' }, { name: '组织审阅' }];
      useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead', 'r-mem', 'r-hidden', 'r-gone'], createdAt: 1 }] });
      const updateTeam = vi.spyOn(useTeamStore.getState(), 'updateTeam');
      render(<TeamView />);
      await openTeamEditor('数据小队');
      fireEvent.click(screen.getByTestId('team-save'));
      await waitFor(() => expect(updateTeam).toHaveBeenCalledTimes(1));
      expect(updateTeam).toHaveBeenCalledWith('t1', {
        name: '数据小队',
        leaderRoleId: 'r-lead',
        memberRoleIds: ['r-hidden', 'r-gone', 'r-mem'],
        leaderNote: undefined,
        requirePlanApproval: false,
        avatar: undefined,
        description: undefined,
        intro: undefined,
        expertise: undefined,
        samplePrompts: undefined,
      });
    });

    it('creates a team with the leader and the picked members, each by its role id', async () => {
      seedAgent('分析师', { roleId: 'r-lead' });
      seedAgent('校对', { roleId: 'r-mem' });
      seedAgent('画图', { roleId: 'r-draw' });
      discoveryState.agents = [{ name: '分析师' }, { name: '校对' }, { name: '画图' }];
      const createTeam = vi.spyOn(useTeamStore.getState(), 'createTeam');
      render(<TeamView />);
      fireEvent.click(screen.getAllByText('新建专家团')[0]);
      fireEvent.change(screen.getByTestId('team-name-input'), { target: { value: '数据小队' } });
      await pickLeader('分析师');
      await pickMembers(['校对', '画图']);
      fireEvent.click(screen.getByTestId('team-save'));
      await waitFor(() => expect(createTeam).toHaveBeenCalledTimes(1));
      expect(createTeam).toHaveBeenCalledWith({
        name: '数据小队',
        leaderRoleId: 'r-lead',
        memberRoleIds: ['r-mem', 'r-draw'],
        leaderNote: undefined,
        requirePlanApproval: false,
        avatar: undefined,
        description: undefined,
        intro: undefined,
        expertise: undefined,
        samplePrompts: undefined,
      });
    });

    it('removes an invalid member from the detail with one store call, and the row leaves the list', () => {
      seedAgent('分析师', { roleId: 'r-lead' });
      seedAgent('校对', { roleId: 'r-mem' });
      discoveryState.agents = [{ name: '分析师' }, { name: '校对' }];
      useTeamStore.setState({ teams: [{ id: 't1', name: '数据小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead', 'r-mem', 'r-gone'], createdAt: 1 }] });
      const updateTeam = vi.spyOn(useTeamStore.getState(), 'updateTeam');
      render(<TeamView />);
      fireEvent.click(screen.getByTestId('team-row-数据小队'));
      fireEvent.click(screen.getByText('移除'));
      expect(updateTeam).toHaveBeenCalledTimes(1);
      expect(updateTeam).toHaveBeenCalledWith('t1', { memberRoleIds: ['r-lead', 'r-mem'] });
      expect(screen.queryByTestId('team-member-invalid-r-gone')).toBeNull();
    });

    it('offers as leader exactly the experts of the member pool: no Abu, no managed expert', async () => {
      seedAgent('分析师', { roleId: 'r-lead' });
      seedAgent('校对', { roleId: 'r-mem' });
      seedAgent('abu');
      registryAgents['组织审阅'] = { name: '组织审阅', description: '', roleId: 'r-hidden', filePath: '/agents/org/AGENT.md', systemPrompt: '', managed: true };
      discoveryState.agents = [{ name: '分析师' }, { name: '校对' }, { name: 'abu' }, { name: '组织审阅' }, { name: '不在注册表' }];
      render(<TeamView />);
      fireEvent.click(screen.getAllByText('新建专家团')[0]);
      expect(await leaderOptionNames()).toEqual(['分析师', '校对']);
    });
  });

  describe('the page on the design system', () => {
    const team = { id: 't1', name: '数据小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead', 'r-mem'], createdAt: 1 };
    const other = { id: 't2', name: '增长小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead'], createdAt: 2 };

    beforeEach(() => {
      settingsState.activeTeamTab = 'teams';
      seedAgent('分析师', { roleId: 'r-lead' });
      seedAgent('校对', { roleId: 'r-mem' });
      seedAgent('画图', { roleId: 'r-draw' });
      discoveryState.agents = [{ name: '分析师' }, { name: '校对' }, { name: '画图' }];
      useTeamStore.setState({ teams: [team, other] });
    });

    it('does not render again when the app around it does', () => {
      settingsState.activeTeamTab = 'members';
      // The shell renders for every piece of a streamed reply; the page takes no props.
      function Shell({ tick }: { tick: number }) {
        return <div data-tick={tick}><TeamView /></div>;
      }
      const view = render(<Shell tick={0} />);
      const before = sectionRenders.mock.calls.length;
      expect(before).toBeGreaterThan(0);
      view.rerender(<Shell tick={1} />);
      view.rerender(<Shell tick={2} />);
      expect(sectionRenders.mock.calls.length).toBe(before);
    });

    it('renders no card again when a detail window opens and closes', async () => {
      render(<TeamView />);
      const total = () => Object.values(cardRenders.byId).reduce((sum, count) => sum + count, 0);
      const before = total();
      expect(before).toBe(2);
      openDetail('数据小队');
      expect(screen.getByRole('dialog', { name: '数据小队' })).toBeInTheDocument();
      fireEvent.keyDown(document, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(total()).toBe(before);
    });

    it('names the detail window after the team, and the edit window after what it does', async () => {
      render(<TeamView />);
      await openTeamEditor('数据小队');
      expect(screen.getByRole('dialog', { name: '编辑专家团' })).toBeInTheDocument();
      // The edit window took the place of the detail window.
      await waitFor(() => expect(screen.queryByRole('dialog', { name: '数据小队' })).toBeNull());
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

      await userEvent.click(screen.getByTestId('team-create-trigger'));
      fireEvent.click(await screen.findByRole('menuitem', { name: '手动创建' }));
      expect(await screen.findByRole('dialog', { name: '新建专家团' })).toBeInTheDocument();
    });

    it('offers 编辑 and 删除 as the entries of a menu', async () => {
      render(<TeamView />);
      openDetail('数据小队');
      await userEvent.click(screen.getByRole('button', { name: '数据小队 的操作' }));
      const menu = await screen.findByRole('menu');
      expect(within(menu).getAllByRole('menuitem').map((item) => item.getAttribute('data-testid'))).toEqual(['team-detail-edit', 'team-detail-delete']);
      expect(within(menu).getByRole('menuitem', { name: '编辑' })).toBeInTheDocument();
      expect(within(menu).getByRole('menuitem', { name: '删除' })).toBeInTheDocument();
    });

    it('asks in a question that names the team', async () => {
      render(<TeamView />);
      const question = await askToDeleteTeam('数据小队');
      expect(question).toHaveAccessibleName('删除这个专家团？');
      expect(question).toHaveTextContent('「数据小队」会被删掉，无法恢复。');
      expect(within(question).getByRole('button', { name: '删除' })).toBeInTheDocument();
    });

    it('deletes nothing when the team has left the store by the time the question is answered', async () => {
      const deleteTeam = vi.spyOn(useTeamStore.getState(), 'deleteTeam');
      render(<TeamView />);
      await askToDeleteTeam('数据小队');
      // The store no longer holds the team; the page has not shown that yet.
      useTeamStore.getState().teams.splice(0, 1);
      await answerDelete();
      await act(async () => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); });
      expect(deleteTeam).not.toHaveBeenCalled();
    });

    it('answers the question with no when the team’s window leaves, and deletes nothing', async () => {
      const deleteTeam = vi.spyOn(useTeamStore.getState(), 'deleteTeam');
      render(<TeamView />);
      await askToDeleteTeam('数据小队');
      // The team leaves the store (a sync from elsewhere): its window goes, and the question with it.
      act(() => { useTeamStore.setState({ teams: [other] }); });
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(deleteTeam).not.toHaveBeenCalled();
    });

    it('answers the question with no when the page leaves, and deletes nothing', async () => {
      const deleteTeam = vi.spyOn(useTeamStore.getState(), 'deleteTeam');
      const view = render(<TeamView />);
      await askToDeleteTeam('数据小队');
      view.unmount();
      await act(async () => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); });
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(deleteTeam).not.toHaveBeenCalled();
      expect(useTeamStore.getState().teams).toHaveLength(2);
    });

    it('lists the leader and the members as plain rows: none of them is a button', () => {
      render(<TeamView />);
      openDetail('数据小队');
      const detail = screen.getByRole('dialog', { name: '数据小队' });
      expect(within(detail).getByText('分析师')).toBeInTheDocument();
      expect(within(detail).getByText('校对')).toBeInTheDocument();
      expect(within(detail).queryByRole('button', { name: /分析师/ })).toBeNull();
      expect(within(detail).queryByRole('button', { name: /校对/ })).toBeNull();
      expect(within(detail).getByText('校对').closest('[tabindex]')).toBe(detail);
    });

    it.each([
      ['deletes nothing', 'team-detail-delete'],
      ['opens no edit window', 'team-detail-edit'],
    ] as const)('%s from a window that is closing', async (_what, entry) => {
      const user = userEvent.setup();
      const deleteTeam = vi.spyOn(useTeamStore.getState(), 'deleteTeam');
      render(<TeamView />);
      openDetail('数据小队');
      keepClosingLayersOnScreen();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(closingWindow()).not.toBeNull();
      // The window takes no pointer input while it fades out; the keyboard still reaches it.
      within(closingWindow()).getByTestId('team-detail-menu').focus();
      await user.keyboard('{Enter}');
      fireEvent.click(await screen.findByTestId(entry));
      // The entry runs once the menu has gone.
      endFade(document.querySelector<HTMLElement>('[role="menu"][data-state="closed"]')!);
      expect(document.querySelector('[role="menu"]')).toBeNull();
      await act(async () => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); });
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(screen.queryByTestId('team-name-input')).toBeNull();
      expect(deleteTeam).not.toHaveBeenCalled();
      finishClosing();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    });

    it('starts no conversation from a window that is closing', () => {
      render(<TeamView />);
      openDetail('数据小队');
      keepClosingLayersOnScreen();
      fireEvent.keyDown(document, { key: 'Escape' });
      fireEvent.click(within(closingWindow()).getByTestId('team-detail-start-chat'));
      expect(settingsState.closeTeam).not.toHaveBeenCalled();
      expect(chatState.startNewConversation).not.toHaveBeenCalled();
      finishClosing();
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('moves the focus to the card that took the place of a deleted team', async () => {
      render(<TeamView />);
      await askToDeleteTeam('数据小队');
      await answerDelete();
      await waitFor(() => expect(screen.queryByTestId('team-row-数据小队')).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(card('增长小队')));
    });

    it('gives the focus back to the team’s card once the edit window has closed', async () => {
      render(<TeamView />);
      await openTeamEditor('数据小队');
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(card('数据小队')));
    });

    it('says an unavailable team in a message with a shape, not in colour alone', () => {
      useTeamStore.getState().registerManagedTeamSource('enterprise', () => true);
      useTeamStore.getState().replaceManagedTeams('enterprise', [{
        id: 'org-team', name: '组织数据小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead'], createdAt: 1,
        managed: { source: 'enterprise', id: 'org-team', version: '1', readOnly: true, ready: false, unavailableReason: '成员不可用：分析师' },
      }]);
      enterpriseState.mode = { kind: 'enterprise', binding: { serverUrl: 'https://enterprise.example' }, config: null };
      useExtensionSourceStore.setState({ sources: { ...DEFAULT_SOURCES } });
      render(<TeamView />);
      openDetail('组织数据小队');
      const message = within(screen.getByTestId('team-managed-unavailable')).getByRole('alert');
      expect(message).toHaveTextContent('成员不可用：分析师');
      expect(message.querySelector('svg')).not.toBeNull();
    });

    it('shows the empty shelf with a title and the button that creates a team', () => {
      useTeamStore.setState({ teams: [] });
      render(<TeamView />);
      expect(screen.getByText('还没有专家团')).toHaveClass('text-title');
      expect(screen.getByRole('button', { name: '新建专家团' })).toBeInTheDocument();
    });

    describe('the edit window', () => {
      it('picks the leader in a combobox whose options carry each expert’s description', async () => {
        render(<TeamView />);
        await openNewTeam();
        await userEvent.click(leaderBox());
        const option = await screen.findByRole('option', { name: '校对' });
        expect(option).toHaveAccessibleDescription('校对 desc');
        fireEvent.click(option);
        // A single choice closes the list.
        await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
        expect(leaderBox()).toHaveTextContent('校对');
      });

      it('turns a member on and off with Enter and keeps the list open', async () => {
        const user = userEvent.setup();
        render(<TeamView />);
        await openNewTeam();
        await user.click(membersBox());
        const first = (await screen.findAllByRole('option'))[0];
        expect(first).toHaveAttribute('aria-checked', 'false');
        await user.keyboard('{Enter}');
        expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByRole('listbox')).toBeInTheDocument();
        expect(membersBox()).toHaveTextContent('分析师');
        await user.keyboard('{Enter}');
        expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-checked', 'false');
        expect(screen.getByRole('listbox')).toBeInTheDocument();
      });

      it('leaves the chosen leader out of the members', async () => {
        render(<TeamView />);
        await openNewTeam();
        await pickLeader('分析师');
        await userEvent.click(membersBox());
        const names = (await screen.findAllByRole('option')).map((option) => option.querySelector('span.truncate')!.textContent);
        expect(names).toEqual(['校对', '画图']);
      });

      it('marks a name another team uses on the field and says so with a mark beside the words', async () => {
        render(<TeamView />);
        await openNewTeam();
        fireEvent.change(screen.getByTestId('team-name-input'), { target: { value: '增长小队' } });
        expect(screen.getByTestId('team-name-input')).toHaveAttribute('aria-invalid', 'true');
        const hint = screen.getByTestId('team-name-taken');
        expect(hint).toHaveTextContent('已有同名专家团，换个名字吧');
        expect(hint.querySelector('svg')).not.toBeNull();
      });

      it('has a switch for plan approval; an arrow key changes nothing, Space does', async () => {
        const user = userEvent.setup();
        const updateTeam = vi.spyOn(useTeamStore.getState(), 'updateTeam');
        render(<TeamView />);
        await openTeamEditor('数据小队');
        const approval = screen.getByRole('switch', { name: '分工先经我确认' });
        expect(approval).toHaveAttribute('aria-checked', 'false');
        approval.focus();
        await user.keyboard('{ArrowRight}{ArrowLeft}');
        expect(approval).toHaveAttribute('aria-checked', 'false');
        await user.keyboard(' ');
        expect(approval).toHaveAttribute('aria-checked', 'true');
        fireEvent.click(screen.getByTestId('team-save'));
        await waitFor(() => expect(updateTeam).toHaveBeenCalledWith('t1', expect.objectContaining({ requirePlanApproval: true })));
      });

      it('removes an invalid member with a named button', async () => {
        useTeamStore.setState({ teams: [{ ...team, memberRoleIds: ['r-lead', 'r-gone'] }] });
        render(<TeamView />);
        await openTeamEditor('数据小队');
        const remove = within(screen.getByTestId('team-edit-invalid-r-gone')).getByRole('button', { name: '移除' });
        expect(remove).toHaveAttribute('data-testid', 'team-edit-invalid-remove-r-gone');
        fireEvent.click(remove);
        expect(screen.queryByTestId('team-edit-invalid-r-gone')).toBeNull();
      });

      it('asks before discarding what was typed, on Escape and on 取消', async () => {
        render(<TeamView />);
        await openNewTeam();
        fireEvent.change(screen.getByTestId('team-name-input'), { target: { value: '新的小队' } });
        fireEvent.keyDown(document, { key: 'Escape' });
        const question = await screen.findByRole('alertdialog', { name: '放弃这些内容？' });
        fireEvent.click(within(question).getByRole('button', { name: '继续填写' }));
        await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
        expect((screen.getByTestId('team-name-input') as HTMLInputElement).value).toBe('新的小队');

        fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }));
        const again = await screen.findByRole('alertdialog', { name: '放弃这些内容？' });
        fireEvent.click(within(again).getByRole('button', { name: '放弃' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(useTeamStore.getState().teams).toHaveLength(2);
      });

      it.each([
        ['a new team', () => openNewTeam()],
        ['an edit', () => openTeamEditor('数据小队')],
      ] as const)('counts an avatar choice as a change: %s asks before closing', async (_what, open) => {
        render(<TeamView />);
        await open();
        fireEvent.click(screen.getByTestId('avatar-picker-trigger'));
        fireEvent.click(screen.getByTestId('avatar-icon-users'));
        // The picker closes first: one Escape, one layer.
        fireEvent.keyDown(document, { key: 'Escape' });
        await waitFor(() => expect(screen.queryByTestId('avatar-picker')).toBeNull());
        expect(screen.queryByRole('alertdialog')).toBeNull();
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(await screen.findByRole('alertdialog', { name: '放弃这些内容？' })).toBeInTheDocument();
      });

      it('keeps the window and what was typed when the save fails, and the button can be pressed again', async () => {
        const { ensureRoleId } = await import('@/core/team/roleIdentity');
        vi.mocked(ensureRoleId).mockRejectedValueOnce(new Error('disk is read-only'));
        const updateTeam = vi.spyOn(useTeamStore.getState(), 'updateTeam');
        render(<TeamView />);
        await openTeamEditor('数据小队');
        fireEvent.change(screen.getByTestId('team-name-input'), { target: { value: '新名字' } });
        fireEvent.click(screen.getByTestId('team-save'));
        await waitFor(() => expect(addToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', title: '保存专家团失败' })));
        expect(updateTeam).not.toHaveBeenCalled();
        expect(screen.getByRole('dialog', { name: '编辑专家团' })).toBeInTheDocument();
        expect((screen.getByTestId('team-name-input') as HTMLInputElement).value).toBe('新名字');
        await waitFor(() => expect(screen.getByTestId('team-save')).not.toHaveAttribute('aria-disabled'));
        fireEvent.click(screen.getByTestId('team-save'));
        await waitFor(() => expect(updateTeam).toHaveBeenCalledTimes(1));
      });

      it('closes without a question once typed input was saved', async () => {
        const updateTeam = vi.spyOn(useTeamStore.getState(), 'updateTeam');
        render(<TeamView />);
        await openTeamEditor('数据小队');
        fireEvent.change(screen.getByTestId('team-name-input'), { target: { value: '新名字' } });
        fireEvent.click(screen.getByTestId('team-save'));
        await waitFor(() => expect(updateTeam).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(screen.queryByTestId('team-name-input')).toBeNull());
        expect(screen.queryByRole('alertdialog')).toBeNull();
        expect(useTeamStore.getState().teams.find((item) => item.id === 't1')?.name).toBe('新名字');
      });

      it('closes at once when nothing was changed, for a new team and for an edit', async () => {
        render(<TeamView />);
        await openNewTeam();
        fireEvent.keyDown(document, { key: 'Escape' });
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

        await openTeamEditor('数据小队');
        fireEvent.keyDown(document, { key: 'Escape' });
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(screen.queryByRole('alertdialog')).toBeNull();
      });

      it('opens blank after an edit window was closed', async () => {
        render(<TeamView />);
        await openTeamEditor('数据小队');
        fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        await openNewTeam();
        expect(screen.getByRole('dialog', { name: '新建专家团' })).toBeInTheDocument();
        expect((screen.getByTestId('team-name-input') as HTMLInputElement).value).toBe('');
        expect(leaderBox()).toHaveTextContent('选择一名队长');
      });

      it('saves nothing from a window that is closing', async () => {
        const updateTeam = vi.spyOn(useTeamStore.getState(), 'updateTeam');
        render(<TeamView />);
        await openTeamEditor('数据小队');
        keepClosingLayersOnScreen();
        fireEvent.keyDown(document, { key: 'Escape' });
        const closing = closingWindow();
        // The window still shows the team it held.
        expect((within(closing).getByTestId('team-name-input') as HTMLInputElement).value).toBe('数据小队');
        expect(closing).toHaveAccessibleName('编辑专家团');
        fireEvent.click(within(closing).getByTestId('team-save'));
        await act(async () => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); });
        expect(updateTeam).not.toHaveBeenCalled();
        expect(addToast).not.toHaveBeenCalled();
        finishClosing();
        expect(screen.queryByRole('dialog')).toBeNull();
      });

      it('saves once: the button stays focusable and takes no second press while the save runs', async () => {
        const { ensureRoleId } = await import('@/core/team/roleIdentity');
        let finish: (value: { roleId: string; wrote: boolean }) => void = () => {};
        vi.mocked(ensureRoleId).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
        const updateTeam = vi.spyOn(useTeamStore.getState(), 'updateTeam');
        render(<TeamView />);
        await openTeamEditor('数据小队');
        const save = screen.getByTestId('team-save');
        fireEvent.click(save);
        await waitFor(() => expect(save).toHaveAttribute('aria-disabled', 'true'));
        expect(save).not.toBeDisabled();
        fireEvent.click(save);
        await act(async () => { finish({ roleId: 'r-lead', wrote: false }); });
        await waitFor(() => expect(updateTeam).toHaveBeenCalledTimes(1));
        expect(vi.mocked(ensureRoleId).mock.calls.filter(([agent]) => (agent as { name: string }).name === '分析师')).toHaveLength(1);
      });
    });

    describe('inside an app', () => {
      const shop = {
        appId: 'shop', name: '店铺运营', pluginKey: 'shop@market', pluginVersion: '1.0.0',
        config: { version: 1, home: { modes: { items: [] } } },
      };
      const shopTeam = { id: 'plugin-team:shop@market/crew', name: '店铺小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead'], createdAt: 3 };

      beforeEach(() => {
        appState.selected = shop;
        useTeamStore.setState({ teams: [team, shopTeam] });
      });

      it('offers 本应用 and 全部 as one choice named after the app, on 本应用', () => {
        render(<TeamView />);
        const scope = within(screen.getByTestId('team-app-scope')).getByRole('group', { name: '店铺运营' });
        expect(within(scope).getByRole('radio', { name: '本应用' })).toHaveAttribute('aria-checked', 'true');
        expect(within(scope).getByRole('radio', { name: '全部' })).toHaveAttribute('aria-checked', 'false');
        expect(screen.getByTestId('team-row-店铺小队')).toBeInTheDocument();
        expect(screen.queryByTestId('team-row-数据小队')).toBeNull();
      });

      it('moves between the two on an arrow key and widens only on Space or a click', async () => {
        const user = userEvent.setup();
        render(<TeamView />);
        screen.getByRole('radio', { name: '本应用' }).focus();
        await user.keyboard('{ArrowRight}');
        expect(screen.getByRole('radio', { name: '全部' })).toHaveFocus();
        expect(screen.getByRole('radio', { name: '全部' })).toHaveAttribute('aria-checked', 'false');
        expect(screen.queryByTestId('team-row-数据小队')).toBeNull();
        await user.keyboard(' ');
        expect(screen.getByRole('radio', { name: '全部' })).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByTestId('team-row-数据小队')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('radio', { name: '本应用' }));
        expect(screen.queryByTestId('team-row-数据小队')).toBeNull();
      });

      it('shows no such choice in the general shell', () => {
        appState.selected = null;
        render(<TeamView />);
        expect(screen.queryByTestId('team-app-scope')).toBeNull();
      });
    });
  });

  describe('built-in teams · 市场 | 我的', () => {
    const userTeam = { id: 't1', name: '数据小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead'], createdAt: 1 };

    beforeEach(() => {
      settingsState.activeTeamTab = 'teams';
      // 市场 is where a fresh install lands, and it is the shelf the shipped
      // teams live on — the suite's other tests opt into 我的 instead.
      useExtensionSourceStore.setState({ sources: { ...DEFAULT_SOURCES } });
    });

    it('lists built-in teams under 市场 and the user\u2019s own under 我的', () => {
      useTeamStore.setState({ teams: [userTeam, ...BUILTIN_TEAMS] });
      render(<TeamView />);
      // Both shelves are reachable, but only one is rendered at a time.
      expect(screen.getByTestId('team-source-market')).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByTestId('team-source-mine')).toHaveTextContent('我的');
      expect(screen.getByTestId(`team-row-${SOFTWARE_RD_TEAM.name}`)).toBeInTheDocument();
      expect(screen.queryByTestId('team-row-数据小队')).toBeNull();

      fireEvent.click(screen.getByTestId('team-source-mine'));

      expect(screen.getByTestId('team-row-数据小队')).toBeInTheDocument();
      expect(screen.queryByTestId(`team-row-${SOFTWARE_RD_TEAM.name}`)).toBeNull();
    });

    it('a built-in team detail has no edit / delete menu', () => {
      useTeamStore.setState({ teams: [...BUILTIN_TEAMS] });
      render(<TeamView />);
      fireEvent.click(screen.getByTestId(`team-row-${SOFTWARE_RD_TEAM.name}`));
      // Read-only: starting work is still the primary action, but there is no
      // 「…」 behind which 编辑 / 删除 could sit.
      expect(screen.getByTestId('team-detail-start-chat')).toBeInTheDocument();
      expect(screen.queryByTestId('team-detail-menu')).toBeNull();
    });

    it('shows 还没有专家团 inside 我的 when only built-ins exist', () => {
      useTeamStore.setState({ teams: [...BUILTIN_TEAMS] });
      render(<TeamView />);
      // The shipped teams are NOT an answer to "have you made a team yet".
      expect(screen.queryByText('还没有专家团')).toBeNull();
      fireEvent.click(screen.getByTestId('team-source-mine'));
      expect(screen.getByText('还没有专家团')).toBeInTheDocument();
      expect(screen.getAllByText('新建专家团').length).toBeGreaterThan(0);
    });
  });

  describe('members off the auto-dispatch pool in the team detail', () => {
    const team = { id: 't1', name: '数据小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead', 'r-b'], createdAt: 1 };

    beforeEach(() => {
      settingsState.activeTeamTab = 'teams';
      seedAgent('L', { roleId: 'r-lead' });
      seedAgent('B', { roleId: 'r-b' });
      discoveryState.agents = [{ name: 'L' }, { name: 'B' }];
      useTeamStore.setState({ teams: [team] });
    });

    // 停用 is about Abu's automatic delegation only: the team detail shows no
    // marker for it, and a leader off the pool still starts the team.
    it('shows no disabled marker and starts the team even when a member is off the auto-dispatch pool', () => {
      settingsState.disabledAgents = ['B', 'L'];
      render(<TeamView />);
      fireEvent.click(screen.getByTestId('team-row-数据小队'));
      expect(screen.queryByTestId('team-member-disabled')).toBeNull();
      expect(screen.queryByTestId('team-leader-disabled-hint')).toBeNull();
      expect(screen.getByTestId('team-detail-start-chat')).not.toBeDisabled();
    });
  });
});
