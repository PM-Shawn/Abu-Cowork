// @vitest-environment happy-dom
/**
 * Which shelf an expert sits on, and what the detail says about where it came
 * from. 「市场」 = shipped with Abu, or brought in by a plugin — read-only
 * either way. 「我的」 = what this user wrote, the only shelf that offers a
 * delete. Getting the split wrong offers a removal the list cannot honour
 * (a plugin's file comes back on the next refresh).
 */

import { render, screen, fireEvent } from '@testing-library/react';
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
};

const pluginMeta: SubagentMetadata = { name: 'reviewer', description: 'Reviews code', source: { kind: 'plugin', plugin: 'weather@official' } };
const builtinMeta: SubagentMetadata = { name: '产品经理', description: '拆需求' };
const userMeta: SubagentMetadata = { name: '我的助手', description: '我写的' };

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
