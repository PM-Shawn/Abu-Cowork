// @vitest-environment happy-dom
/**
 * Which shelf an expert sits on, and what the detail says about where it came
 * from. 「市场」 = shipped with Abu, or brought in by a plugin — read-only
 * either way. 「我的」 = what this user wrote, the only shelf that offers a
 * delete. Getting the split wrong offers a removal the list cannot honour
 * (a plugin's file comes back on the next refresh).
 */

import type { ReactElement } from 'react';
import { act, render as renderBare, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';

// The detail window is a design-system dialog, so the section renders inside the provider like the app does.
const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });
import type { SubagentDefinition, SubagentMetadata } from '@/types';
import type { InstalledPlugin } from '@/core/plugin/installedStore';

vi.mock('@/core/agent/registry', () => ({
  agentRegistry: { getAgent: vi.fn(), getAvailableAgents: vi.fn(() => []) },
  // What the editor window reads when it opens and saves.
  getBuiltinAgentNames: () => [],
  serializeAgentMd: vi.fn(() => 'md'),
}));

vi.mock('@/core/plugin/installedStore', async (importOriginal) => {
  const readInstalled = vi.fn(async (_home: string) => [] as InstalledPlugin[]);
  return {
    ...(await importOriginal<typeof import('@/core/plugin/installedStore')>()),
    readInstalled,
    readInstalledResult: vi.fn(async (home: string) => ({ ok: true, plugins: await readInstalled(home) })),
  };
});

// How many times each card has rendered, by the id of its item.
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

// The editor writes through the storage layer; these tests only open and close its window.
vi.mock('@/utils/itemStorage', () => ({
  ITEM_EXISTS_CODE: 'ITEM_EXISTS',
  ITEM_NAME_INVALID_CODE: 'ITEM_NAME_INVALID',
  saveItemToAbuDir: vi.fn(async () => undefined),
}));

import { remove as fsRemove } from '@tauri-apps/plugin-fs';
import { agentRegistry } from '@/core/agent/registry';
import { readInstalled } from '@/core/plugin/installedStore';
import { format, getI18n, setLanguage } from '@/i18n';
import { usePluginStore } from '@/stores/pluginStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useTeamStore } from '@/stores/teamStore';
import { useExtensionSourceStore } from '@/stores/extensionSourceStore';
import { saveItemToAbuDir } from '@/utils/itemStorage';
import AgentsSection from './AgentsSection';

const weather: InstalledPlugin = {
  key: 'weather@official',
  marketplace: 'official',
  name: 'Weather Pack',
  version: '1.2.0',
  installedAt: '2026-01-01T00:00:00.000Z',
  contributed: { skills: [], mcpServers: [], agents: ['reviewer'], teams: [] },
};

const definitions: Record<string, SubagentDefinition> = {
  // A plugin's expert is file-backed — only `installed.json` says it is a
  // plugin's, which is exactly why the shelf split cannot read the path alone.
  reviewer: { name: 'reviewer', description: 'Reviews code', systemPrompt: 'x', filePath: '/Users/tester/.abu/plugin-packages/official/weather/1.2.0/agents/reviewer/AGENT.md' },
  产品经理: { name: '产品经理', description: '拆需求', systemPrompt: 'x', filePath: '__builtin__' },
  我的助手: { name: '我的助手', description: '我写的', systemPrompt: 'x', filePath: '/Users/tester/.abu/agents/mine/AGENT.md' },
  // A hand-edited AGENT.md whose `tools:` is not a list — the one thing the
  // card still has to say about tools.
  坏工具: { name: '坏工具', description: '配置写坏了', systemPrompt: 'x', filePath: '/Users/tester/.abu/agents/bad/AGENT.md', tools: 'all' as unknown as string[] },
};

const pluginMeta: SubagentMetadata = { name: 'reviewer', description: 'Reviews code', source: { kind: 'plugin', plugin: 'weather@official' } };
const builtinMeta: SubagentMetadata = { name: '产品经理', description: '拆需求' };
const userMeta: SubagentMetadata = { name: '我的助手', description: '我写的' };
const badToolsMeta: SubagentMetadata = { name: '坏工具', description: '配置写坏了' };

/** The header's "..." button — absent entirely for a 市场 expert. */
const menuButton = () => [...document.querySelectorAll('button')].find((b) =>
  /ellipsis|more-horizontal/.test(b.querySelector('svg')?.getAttribute('class') ?? ''),
);

function renderShelf(source: 'market' | 'mine', metas: SubagentMetadata[], searchQuery?: string) {
  useDiscoveryStore.setState({ agents: metas, skills: [], isLoading: false });
  render(<AgentsSection source={source} searchQuery={searchQuery} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(agentRegistry.getAgent).mockImplementation((name: string) => definitions[name]);
  vi.mocked(readInstalled).mockResolvedValue([]);
  usePluginStore.setState({ installed: [weather] });
  useSettingsStore.setState({ extensionsSearchQueries: { plugins: '', skills: '', mcp: '' }, disabledAgents: [] });
  useDiscoveryStore.setState({ refresh: vi.fn(async () => undefined) });
  setLanguage('zh-CN');
});

afterEach(() => {
  setLanguage('system');
});

describe('AgentsSection — which shelf an expert lands on', () => {
  it('keeps 市场 for the shipped experts only', () => {
    renderShelf('market', [pluginMeta, builtinMeta, userMeta]);
    expect(screen.getByText('产品经理')).toBeInTheDocument();
    expect(screen.queryByText('reviewer')).toBeNull();
    expect(screen.queryByText('我的助手')).toBeNull();
  });

  it('puts a plugin-owned expert on 我的 — the user installed it — badged with its plugin', () => {
    renderShelf('mine', [pluginMeta, builtinMeta, userMeta]);
    expect(screen.getByText('我的助手')).toBeInTheDocument();
    expect(screen.queryByText('产品经理')).toBeNull();
    const card = screen.getByText('reviewer').closest('[role="button"]') as HTMLElement;
    expect(within(card).getByTestId('source-badge')).toHaveTextContent('来自插件 Weather Pack');
    expect(within(screen.getByText('我的助手').closest('[role="button"]') as HTMLElement).queryByTestId('source-badge')).toBeNull();
  });
});

describe('AgentsSection — what the detail says about provenance', () => {
  it('names the plugin, and offers no 「…」 menu, for a plugin-owned expert', () => {
    renderShelf('mine', [pluginMeta]);
    fireEvent.click(screen.getByText('reviewer'));
    expect(screen.getByTestId('agent-added-by')).toHaveTextContent('来自插件 Weather Pack · 卸载插件即可移除');
    expect(menuButton()).toBeUndefined();
  });

  it('says 市场 for a shipped expert', () => {
    // The shipped roster IS the OSS market shelf since v0.50 — 「内置」 would
    // name a third place the UI no longer has.
    renderShelf('market', [builtinMeta]);
    fireEvent.click(screen.getByText('产品经理'));
    expect(screen.getByTestId('agent-added-by')).toHaveTextContent('市场');
    expect(menuButton()).toBeUndefined();
  });

  it('offers 删除 — not 卸载 — on the user’s own expert', async () => {
    renderShelf('mine', [userMeta]);
    fireEvent.click(screen.getByText('我的助手'));
    expect(screen.getByTestId('agent-added-by')).toHaveTextContent('用户');
    const menu = menuButton();
    expect(menu).toBeDefined();
    await userEvent.click(menu!);
    expect(await screen.findByText('删除')).toBeInTheDocument();
    expect(screen.queryByText('卸载')).toBeNull();
  });
});

describe('AgentsSection — the 我的 empty state tells the truth', () => {
  it('says 未找到专家 when the user HAS experts but the search matches none', () => {
    // "还没有你创建的专家" here would be a lie the user can disprove by
    // clearing the search box.
    renderShelf('mine', [userMeta], 'zzz-no-such-expert');
    expect(screen.getByText('未找到专家')).toBeInTheDocument();
    expect(screen.queryByText('还没有你创建的专家')).toBeNull();
  });

  it('says 还没有你创建的专家 when the user has none at all and is not searching', () => {
    renderShelf('mine', [builtinMeta]);
    expect(screen.getByText('还没有你创建的专家')).toBeInTheDocument();
    expect(screen.queryByText('未找到专家')).toBeNull();
  });
});

/**
 * The card is avatar + name + description. The tool count and the source line
 * moved to the detail view so a six-character name survives four columns; what
 * is left is the warning for a tools field Abu could not read, since that is an
 * error the user has to go fix, not information.
 */
describe('AgentsSection — what the card row carries', () => {
  it('shows no tool count on a card', () => {
    renderShelf('market', [builtinMeta]);
    expect(screen.getByText('产品经理')).toBeInTheDocument();
    expect(screen.queryByText('全部工具')).toBeNull();
    expect(screen.queryByText(/个工具/)).toBeNull();
  });

  it('still flags an expert whose tools field is unreadable', () => {
    renderShelf('mine', [userMeta, badToolsMeta]);
    expect(screen.getByText('工具配置无效')).toBeInTheDocument();
    // …and only on that card.
    expect(screen.getAllByText('工具配置无效')).toHaveLength(1);
  });

  it('keeps a visible grey plate under an expert that picked no icon', () => {
    // The avatar fills the 40px slot, so it — not the slot — paints what the
    // user sees: the neutral fill under the robot mark, which shows on the
    // card's surface. No identity colour replaces it.
    renderShelf('market', [builtinMeta]);
    const avatar = document.querySelector('[data-testid="agent-avatar"]')!;
    expect(avatar).toHaveClass('size-10');
    expect(avatar).toHaveClass('bg-fill');
    expect(avatar).not.toHaveAttribute('style');
  });

  it('keeps that plate under the default avatar in the opened detail too', () => {
    // The other slot: the detail header's plate is 56px, and a `2xl` avatar
    // covers it exactly, so the avatar paints the plate there too. The card's
    // own avatar stays in the DOM behind the window, so pick the one inside
    // the window.
    renderShelf('market', [builtinMeta]);
    fireEvent.click(screen.getByText('产品经理'));
    const avatar = within(screen.getByRole('dialog', { name: '产品经理' })).getByTestId('agent-avatar');
    expect(avatar).toHaveClass('size-14');
    expect(avatar).toHaveClass('bg-fill');
    expect(avatar).not.toHaveAttribute('style');
  });
});

/**
 * The switch on an expert never meant "this expert is off" — it only says
 * whether Abu may hand it work on its own. Shown as an on/off switch on the
 * card it read as a kill switch, so the card only reports the state and the
 * detail owns the setting.
 */
describe('AgentsSection — the switch is an auto-dispatch setting, not an on/off', () => {
  it('renders no toggle on expert cards; shows a 不自动派单 tag only when the expert is off the pool', () => {
    useSettingsStore.setState({ disabledAgents: ['reviewer'] });
    renderShelf('mine', [pluginMeta, userMeta]);
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    expect(screen.getAllByTestId('agent-auto-dispatch-off')).toHaveLength(1);
    expect(screen.getByTestId('agent-auto-dispatch-off')).toHaveTextContent('不自动派单');
  });

  it('lets the two chips wrap — a narrow column costs a line, not the error chip', () => {
    // 「不自动派单」 and 「工具配置无效」 can land on the same card. The badge is
    // the slot ToolCard squeezes first (`min-w-0 shrink overflow-hidden`), and
    // text chips do not shrink — without flex-wrap the second one, the error
    // the user has to go fix, is what gets cut off.
    useSettingsStore.setState({ disabledAgents: ['坏工具'] });
    renderShelf('mine', [badToolsMeta]);
    expect(screen.getByText('工具配置无效')).toBeInTheDocument();
    const badge = screen.getByTestId('agent-auto-dispatch-off').parentElement!;
    expect(badge).toContainElement(screen.getByText('工具配置无效'));
    expect(badge.className).toContain('flex-wrap');
  });

  it('detail offers 开始对话 and the auto-dispatch setting even when the expert is off the pool', () => {
    useSettingsStore.setState({ disabledAgents: ['reviewer'] });
    renderShelf('mine', [pluginMeta]);
    fireEvent.click(screen.getByText('reviewer'));
    // 开始对话 is the detail's footer button; being off the pool is not being
    // off, so it is neither hidden nor disabled.
    expect(screen.getByTestId('agent-detail-start-chat')).toBeEnabled();
    const toggle = within(screen.getByTestId('agent-auto-dispatch-setting')).getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    expect(useSettingsStore.getState().disabledAgents).toEqual([]);
  });

  it('takes exactly the expert whose detail is open off the pool, with one store call', () => {
    const toggleAgentEnabled = vi.spyOn(useSettingsStore.getState(), 'toggleAgentEnabled');
    renderShelf('mine', [pluginMeta, userMeta]);
    fireEvent.click(screen.getByText('我的助手'));
    const toggle = within(screen.getByTestId('agent-auto-dispatch-setting')).getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(toggle);
    expect(toggleAgentEnabled).toHaveBeenCalledTimes(1);
    expect(toggleAgentEnabled).toHaveBeenCalledWith('我的助手');
    expect(useSettingsStore.getState().disabledAgents).toEqual(['我的助手']);
  });
});

const tb = () => getI18n().toolbox;
const card = (name: string) => screen.getByText(name).closest('[role="button"]') as HTMLElement;
const detailMenu = (name: string) => screen.getByRole('button', { name: format(tb().itemMenuLabel, { name }) });

/** Opens the expert's window from its card, the way a key press on the card does: the card has the focus. */
function openDetail(name: string) {
  card(name).focus();
  fireEvent.click(card(name));
}

/** Chooses an entry of the window's 「…」 menu. What the entry does runs once the menu has gone. */
async function choose(name: string, entry: string) {
  await userEvent.click(detailMenu(name));
  fireEvent.click(await screen.findByRole('menuitem', { name: entry }));
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

const reviewerInTeam = { id: 't1', name: '网页开发专家团', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead', 'r-mine'], createdAt: 1 };

describe('AgentsSection — the detail window', () => {
  beforeEach(() => {
    cardRenders.byId = {};
    useTeamStore.setState({ teams: [] });
    definitions['我的助手'] = { ...definitions['我的助手'], roleId: 'r-mine' };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is a window named after the expert', () => {
    renderShelf('mine', [userMeta]);
    openDetail('我的助手');
    expect(screen.getByRole('dialog', { name: '我的助手' })).toBeInTheDocument();
  });

  it('offers 编辑 and 删除 as the entries of a menu', async () => {
    renderShelf('mine', [userMeta]);
    openDetail('我的助手');
    await userEvent.click(detailMenu('我的助手'));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: tb().agentEdit })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: tb().deleteItem })).toBeInTheDocument();
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(2);
  });

  it('names the auto-dispatch switch after the setting; an arrow key changes nothing, Space does', async () => {
    const user = userEvent.setup();
    const toggleAgentEnabled = vi.spyOn(useSettingsStore.getState(), 'toggleAgentEnabled');
    renderShelf('mine', [userMeta]);
    openDetail('我的助手');
    const setting = screen.getByRole('switch', { name: tb().agentAutoDispatch });
    setting.focus();
    await user.keyboard('{ArrowRight}{ArrowLeft}{ArrowDown}{ArrowUp}');
    expect(toggleAgentEnabled).not.toHaveBeenCalled();
    await user.keyboard(' ');
    expect(toggleAgentEnabled).toHaveBeenCalledTimes(1);
    expect(toggleAgentEnabled).toHaveBeenCalledWith('我的助手');
  });

  it('asks in a question that names the expert, and removes its folder on 仍然删除', async () => {
    useTeamStore.setState({ teams: [reviewerInTeam] });
    renderShelf('mine', [userMeta]);
    openDetail('我的助手');
    await choose('我的助手', tb().deleteItem);
    const question = await screen.findByRole('alertdialog', { name: format(tb().agentDeleteInTeamsTitle, { name: '我的助手' }) });
    expect(question).toHaveTextContent('网页开发专家团');
    expect(vi.mocked(fsRemove)).not.toHaveBeenCalled();
    fireEvent.click(within(question).getByRole('button', { name: tb().agentDeleteAnyway }));
    await waitFor(() => expect(vi.mocked(fsRemove)).toHaveBeenCalledWith('/Users/tester/.abu/agents/mine', { recursive: true }));
    expect(vi.mocked(fsRemove)).toHaveBeenCalledTimes(1);
  });

  it('removes nothing when the expert has left the list by the time the question is answered', async () => {
    useTeamStore.setState({ teams: [reviewerInTeam] });
    renderShelf('mine', [userMeta]);
    openDetail('我的助手');
    await choose('我的助手', tb().deleteItem);
    const question = await screen.findByRole('alertdialog');
    // The expert's file has gone; the page has not shown that yet.
    vi.mocked(agentRegistry.getAgent).mockImplementation(() => undefined);
    fireEvent.click(within(question).getByRole('button', { name: tb().agentDeleteAnyway }));
    await act(async () => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); });
    expect(vi.mocked(fsRemove)).not.toHaveBeenCalled();
  });

  it.each([
    ['a team lists it', true, () => tb().agentDeleteAnyway],
    ['no team lists it', false, () => getI18n().common.delete],
  ] as const)('removes nothing when the name leads to another owner’s expert by the time the question is answered (%s)', async (_what, listed, answer) => {
    if (listed) useTeamStore.setState({ teams: [reviewerInTeam] });
    renderShelf('mine', [userMeta]);
    openDetail('我的助手');
    await choose('我的助手', tb().deleteItem);
    const question = await screen.findByRole('alertdialog');
    // A plugin's expert of the same name has taken the place of the user's own.
    const pluginsOwn = { ...definitions['我的助手'], filePath: '/Users/tester/.abu/plugin-packages/official/weather/1.2.0/agents/mine/AGENT.md' };
    vi.mocked(agentRegistry.getAgent).mockImplementation(() => pluginsOwn);
    fireEvent.click(within(question).getByRole('button', { name: answer() }));
    await act(async () => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); });
    expect(vi.mocked(fsRemove)).not.toHaveBeenCalled();
  });

  it('asks before deleting an expert no team lists, in a question that names it', async () => {
    renderShelf('mine', [userMeta]);
    openDetail('我的助手');
    await choose('我的助手', tb().deleteItem);
    const question = await screen.findByRole('alertdialog', { name: tb().deleteItem });
    expect(question).toHaveTextContent('我的助手');
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    expect(vi.mocked(fsRemove)).not.toHaveBeenCalled();
    fireEvent.click(within(question).getByRole('button', { name: getI18n().common.cancel }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await act(async () => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); });
    expect(vi.mocked(fsRemove)).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: '我的助手' })).toBeInTheDocument();

    await choose('我的助手', tb().deleteItem);
    const again = await screen.findByRole('alertdialog', { name: tb().deleteItem });
    fireEvent.click(within(again).getByRole('button', { name: getI18n().common.delete }));
    await waitFor(() => expect(vi.mocked(fsRemove)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(fsRemove)).toHaveBeenCalledWith('/Users/tester/.abu/agents/mine', { recursive: true });
  });

  it('asks one question, the one about the teams, for an expert a team lists', async () => {
    useTeamStore.setState({ teams: [reviewerInTeam] });
    renderShelf('mine', [userMeta]);
    openDetail('我的助手');
    await choose('我的助手', tb().deleteItem);
    const question = await screen.findByRole('alertdialog', { name: format(tb().agentDeleteInTeamsTitle, { name: '我的助手' }) });
    fireEvent.click(within(question).getByRole('button', { name: tb().agentDeleteAnyway }));
    await waitFor(() => expect(vi.mocked(fsRemove)).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('answers the question with no when the page leaves, and removes nothing', async () => {
    useDiscoveryStore.setState({ agents: [userMeta], skills: [], isLoading: false });
    const view = render(<AgentsSection source="mine" />);
    openDetail('我的助手');
    await choose('我的助手', tb().deleteItem);
    await screen.findByRole('alertdialog');
    view.unmount();
    await act(async () => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(vi.mocked(fsRemove)).not.toHaveBeenCalled();
  });

  it('answers the question with no when the window leaves, and removes nothing', async () => {
    useTeamStore.setState({ teams: [reviewerInTeam] });
    renderShelf('mine', [userMeta]);
    openDetail('我的助手');
    await choose('我的助手', tb().deleteItem);
    await screen.findByRole('alertdialog');
    // The expert leaves the list (a refresh): its window goes, and the question with it.
    act(() => { useDiscoveryStore.setState({ agents: [] }); });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(vi.mocked(fsRemove)).not.toHaveBeenCalled();
  });

  it.each([
    ['removes nothing', () => tb().deleteItem],
    ['opens no editor', () => tb().agentEdit],
  ] as const)('%s from a window that is closing', async (_what, entry) => {
    const user = userEvent.setup();
    renderShelf('mine', [userMeta]);
    openDetail('我的助手');
    keepClosingLayersOnScreen();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(closingWindow()).not.toBeNull();
    // The window takes no pointer input while it fades out; the keyboard still reaches it.
    within(closingWindow()).getByRole('button', { name: format(tb().itemMenuLabel, { name: '我的助手' }) }).focus();
    await user.keyboard('{Enter}');
    fireEvent.click(await screen.findByRole('menuitem', { name: entry() }));
    // The entry runs once the menu has gone.
    endFade(document.querySelector<HTMLElement>('[role="menu"][data-state="closed"]')!);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await act(async () => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); });
    expect(vi.mocked(fsRemove)).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText('my-agent')).toBeNull();
    endFade(closingWindow());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('starts no conversation from a window that is closing', () => {
    const closeExtensions = vi.spyOn(useSettingsStore.getState(), 'closeExtensions');
    renderShelf('mine', [userMeta]);
    openDetail('我的助手');
    keepClosingLayersOnScreen();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(within(closingWindow()).getByTestId('agent-detail-start-chat'));
    expect(closeExtensions).not.toHaveBeenCalled();
    endFade(closingWindow());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('shows the empty shelf with a title and the button that creates an expert', () => {
    renderShelf('mine', [builtinMeta]);
    expect(screen.getByText(tb().agentsMineEmpty)).toHaveClass('text-title');
    expect(screen.getByText(tb().agentsMineEmptyHint)).toBeInTheDocument();
    expect(screen.getByTestId('agents-mine-create')).toHaveTextContent(tb().createAgent);
  });

  it('marks an unreadable tools field with a warning tag: its colour and its shape', () => {
    renderShelf('mine', [badToolsMeta]);
    const tag = screen.getByText(tb().agentInvalidTools);
    expect(tag).toHaveClass('bg-warning-soft');
    expect(tag.querySelector('svg')).not.toBeNull();
    // The hint stays readable when the tag is cut off.
    expect(tag.closest('[title]')).toHaveAttribute('title', tb().agentInvalidTools);
  });

  it('shows the system prompt as a preview or as its source, each a named button that says which is on', () => {
    renderShelf('mine', [userMeta]);
    openDetail('我的助手');
    const preview = screen.getByRole('button', { name: getI18n().panel.previewMode });
    const source = screen.getByRole('button', { name: getI18n().panel.sourceMode });
    expect(preview).toHaveAttribute('aria-pressed', 'true');
    expect(source).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(source);
    expect(source).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('dialog').querySelector('pre')).toHaveClass('font-code');
  });

  it('renders no card again when a detail window opens and closes', async () => {
    renderShelf('mine', [userMeta, badToolsMeta, pluginMeta]);
    const total = () => Object.values(cardRenders.byId).reduce((sum, count) => sum + count, 0);
    await screen.findByText('我的助手');
    const before = total();
    openDetail('我的助手');
    expect(screen.getByRole('dialog', { name: '我的助手' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(total()).toBe(before);
  });

  it('gives the focus back to the card once the window has closed', async () => {
    renderShelf('mine', [userMeta, badToolsMeta]);
    openDetail('我的助手');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(card('我的助手')));
  });

  it('moves the focus to the card that took the place of a deleted expert', async () => {
    renderShelf('mine', [userMeta, badToolsMeta]);
    // The section reads the installed plugins when it mounts, which ends in a refresh of the list.
    await act(async () => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); });
    // From here on a refresh finds the folder gone.
    act(() => { useDiscoveryStore.setState({ refresh: vi.fn(async () => { useDiscoveryStore.setState({ agents: [badToolsMeta] }); }) }); });
    openDetail('我的助手');
    await choose('我的助手', tb().deleteItem);
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: getI18n().common.delete }));
    await waitFor(() => expect(vi.mocked(fsRemove)).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText('我的助手')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(card('坏工具')));
  });
});

describe('AgentsSection — the editor window', () => {
  beforeEach(() => {
    useTeamStore.setState({ teams: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens in place of the detail window, named 编辑专家, holding the expert', async () => {
    renderShelf('mine', [userMeta]);
    openDetail('我的助手');
    await choose('我的助手', tb().agentEdit);
    const editor = await screen.findByRole('dialog', { name: tb().agentEditorTitleEdit });
    expect((within(editor).getByPlaceholderText('my-agent') as HTMLInputElement).value).toBe('我的助手');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '我的助手' })).toBeNull());
  });

  it('opens blank, named 新建专家, from the empty shelf', async () => {
    renderShelf('mine', [builtinMeta]);
    fireEvent.click(screen.getByTestId('agents-mine-create'));
    const editor = await screen.findByRole('dialog', { name: tb().agentEditorTitleNew });
    expect((within(editor).getByPlaceholderText('my-agent') as HTMLInputElement).value).toBe('');
  });

  it('opens blank when the page asks for a manual create', async () => {
    useDiscoveryStore.setState({ agents: [userMeta], skills: [], isLoading: false });
    render(<AgentsSection source="mine" manualCreateTrigger={1} />);
    expect(await screen.findByRole('dialog', { name: tb().agentEditorTitleNew })).toBeInTheDocument();
  });

  it('asks before discarding what was typed, and closes at once when nothing was', async () => {
    renderShelf('mine', [builtinMeta]);
    fireEvent.click(screen.getByTestId('agents-mine-create'));
    const editor = await screen.findByRole('dialog', { name: tb().agentEditorTitleNew });
    fireEvent.change(within(editor).getByPlaceholderText('my-agent'), { target: { value: 'fresh' } });
    fireEvent.keyDown(document, { key: 'Escape' });
    const question = await screen.findByRole('alertdialog', { name: getI18n().designSystem.discardTitle });
    fireEvent.click(within(question).getByRole('button', { name: getI18n().designSystem.discard }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByTestId('agents-mine-create'));
    const again = await screen.findByRole('dialog', { name: tb().agentEditorTitleNew });
    expect((within(again).getByPlaceholderText('my-agent') as HTMLInputElement).value).toBe('');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('after a save: reads the list again, closes the window and shows 我的', async () => {
    const refresh = vi.mocked(useDiscoveryStore.getState().refresh);
    const setSource = vi.spyOn(useExtensionSourceStore.getState(), 'setSource');
    renderShelf('mine', [userMeta]);
    openDetail('我的助手');
    await choose('我的助手', tb().agentEdit);
    const editor = await screen.findByRole('dialog', { name: tb().agentEditorTitleEdit });
    refresh.mockClear();
    // Typed input does not make a save ask before the window closes.
    fireEvent.change(within(editor).getByLabelText(tb().agentEditorDescription), { target: { value: '改过的描述' } });
    fireEvent.click(within(editor).getByTestId('agent-editor-save'));
    await waitFor(() => expect(vi.mocked(saveItemToAbuDir)).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(setSource).toHaveBeenCalledTimes(1);
    expect(setSource).toHaveBeenCalledWith('members', 'mine');
    expect(refresh.mock.invocationCallOrder[0]).toBeLessThan(setSource.mock.invocationCallOrder[0]);
  });

  it('gives the focus to the expert’s card once the editor has closed', async () => {
    renderShelf('mine', [userMeta, badToolsMeta]);
    openDetail('我的助手');
    await choose('我的助手', tb().agentEdit);
    const editor = await screen.findByRole('dialog', { name: tb().agentEditorTitleEdit });
    fireEvent.click(within(editor).getByRole('button', { name: getI18n().common.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(card('我的助手')));
  });
});
