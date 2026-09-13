// @vitest-environment happy-dom
/**
 * Which shelf an expert sits on, and what the detail says about where it came
 * from. 「市场」 = shipped with Abu, or brought in by a plugin — read-only
 * either way. 「我的」 = what this user wrote, the only shelf that offers a
 * delete. Getting the split wrong offers a removal the list cannot honour
 * (a plugin's file comes back on the next refresh).
 */

import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { SubagentDefinition, SubagentMetadata } from '@/types';
import type { InstalledPlugin } from '@/core/plugin/installedStore';

vi.mock('@/core/agent/registry', () => ({
  agentRegistry: { getAgent: vi.fn(), getAvailableAgents: vi.fn(() => []) },
}));

vi.mock('@/core/plugin/installedStore', async (importOriginal) => {
  const readInstalled = vi.fn(async (_home: string) => [] as InstalledPlugin[]);
  return {
    ...(await importOriginal<typeof import('@/core/plugin/installedStore')>()),
    readInstalled,
    readInstalledResult: vi.fn(async (home: string) => ({ ok: true, plugins: await readInstalled(home) })),
  };
});

import { agentRegistry } from '@/core/agent/registry';
import { readInstalled } from '@/core/plugin/installedStore';
import { setLanguage } from '@/i18n';
import { usePluginStore } from '@/stores/pluginStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useSettingsStore } from '@/stores/settingsStore';
import AgentsSection from './AgentsSection';

const weather: InstalledPlugin = {
  key: 'weather@official',
  marketplace: 'official',
  name: 'Weather Pack',
  version: '1.2.0',
  installedAt: '2026-01-01T00:00:00.000Z',
  contributed: { skills: [], mcpServers: [], agents: ['reviewer'] },
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
  it('puts a plugin-owned expert on 市场 together with the shipped ones', () => {
    renderShelf('market', [pluginMeta, builtinMeta, userMeta]);
    expect(screen.getByText('reviewer')).toBeInTheDocument();
    expect(screen.getByText('产品经理')).toBeInTheDocument();
    expect(screen.queryByText('我的助手')).toBeNull();
  });

  it('keeps a plugin-owned expert off 我的 — it is not the user’s to remove', () => {
    renderShelf('mine', [pluginMeta, builtinMeta, userMeta]);
    expect(screen.getByText('我的助手')).toBeInTheDocument();
    expect(screen.queryByText('reviewer')).toBeNull();
    expect(screen.queryByText('产品经理')).toBeNull();
  });
});

describe('AgentsSection — what the detail says about provenance', () => {
  it('names the plugin, and offers no 「…」 menu, for a plugin-owned expert', () => {
    renderShelf('market', [pluginMeta]);
    fireEvent.click(screen.getByText('reviewer'));
    expect(screen.getByTestId('agent-added-by')).toHaveTextContent('来自插件 Weather Pack · 卸载插件即可移除');
    expect(menuButton()).toBeUndefined();
  });

  it('says 市场 for a shipped expert', () => {
    // The shipped roster IS the OSS market shelf since v0.43 — 「内置」 would
    // name a third place the UI no longer has.
    renderShelf('market', [builtinMeta]);
    fireEvent.click(screen.getByText('产品经理'));
    expect(screen.getByTestId('agent-added-by')).toHaveTextContent('市场');
    expect(menuButton()).toBeUndefined();
  });

  it('offers 删除 — not 卸载 — on the user’s own expert', () => {
    renderShelf('mine', [userMeta]);
    fireEvent.click(screen.getByText('我的助手'));
    expect(screen.getByTestId('agent-added-by')).toHaveTextContent('用户');
    const menu = menuButton();
    expect(menu).toBeDefined();
    fireEvent.click(menu!);
    expect(screen.getByText('删除')).toBeInTheDocument();
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

  it('says 还没有你创建的专家 when the user has none and is not searching', () => {
    renderShelf('mine', [builtinMeta, pluginMeta]);
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
    // The avatar fills the 40px slot now, so it — not the slot — paints what
    // the user sees. Its own default is `--abu-bg-muted` (#f5f3ee), all but
    // invisible on a card whose ground is `--abu-bg-subtle` (#f8f8f4), leaving
    // the robot mark floating. The card asks for the slot's own
    // `--abu-bg-active` (#f0eee6) back, which is the plate that was there
    // before the avatar grew.
    renderShelf('market', [builtinMeta]);
    const avatar = document.querySelector('[data-testid="agent-avatar"]')!;
    expect(avatar.className).toContain('bg-[var(--abu-bg-active)]');
    expect(avatar.className).not.toContain('bg-[var(--abu-bg-muted)]');
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
    renderShelf('market', [pluginMeta, builtinMeta]);
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
    renderShelf('market', [pluginMeta]);
    fireEvent.click(screen.getByText('reviewer'));
    // 开始对话 is the detail's footer button; being off the pool is not being
    // off, so it is neither hidden nor disabled.
    expect(screen.getByTestId('agent-detail-start-chat')).toBeEnabled();
    const toggle = within(screen.getByTestId('agent-auto-dispatch-setting')).getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    expect(useSettingsStore.getState().disabledAgents).toEqual([]);
  });
});
