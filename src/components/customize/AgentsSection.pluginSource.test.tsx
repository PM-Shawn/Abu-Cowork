// @vitest-environment happy-dom
/**
 * The live agent detail (扩展 › 代理) is this section's `ToolDetailModal`, not
 * the standalone `AgentDetailModal`. Same contract: a plugin-contributed agent
 * says where it came from, and neither editing nor deleting it is offered —
 * a plugin update would overwrite the edit, and the file goes away when the
 * plugin is uninstalled.
 *
 * The provenance itself arrives on the discovery store's metadata (backfilled
 * from `installed.json`), while the detail body comes from the registry — so
 * this also pins that the section carries the label across that join.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SubagentDefinition, SubagentMetadata } from '@/types';
import type { InstalledPlugin } from '@/core/plugin/installedStore';

vi.mock('@/core/agent/registry', () => ({
  agentRegistry: { getAgent: vi.fn(), getAvailableAgents: vi.fn(() => []) },
}));

// Only the disk read is faked; `pluginDisplayName` stays real — the point of
// the hydration test is that the real key→name lookup has something to look at.
vi.mock('@/core/plugin/installedStore', async (importOriginal) => {
  const readInstalled = vi.fn(async (_home: string) => [] as import('@/core/plugin/installedStore').InstalledPlugin[]);
  return {
    ...(await importOriginal<typeof import('@/core/plugin/installedStore')>()),
    readInstalled,
    // The store reads through the result variant; keep both fed by the same
    // fake so a test only has to drive `readInstalled`.
    readInstalledResult: vi.fn(async (home: string) => ({ ok: true, plugins: await readInstalled(home) })),
  };
});

import { remove as fsRemove } from '@tauri-apps/plugin-fs';
import { agentRegistry } from '@/core/agent/registry';
import { readInstalled } from '@/core/plugin/installedStore';
import { getI18n, format, setLanguage } from '@/i18n';
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

const definition: SubagentDefinition = {
  name: 'reviewer',
  description: 'Reviews code',
  systemPrompt: 'You review code.',
  filePath: '/Users/tester/.abu/agents/reviewer/AGENT.md',
};

const tb = () => getI18n().toolbox;

/** Render the section with `reviewer` discovered, then open its detail. */
function openDetail(meta: SubagentMetadata) {
  useDiscoveryStore.setState({ agents: [meta], skills: [], isLoading: false });
  render(<AgentsSection />);
  fireEvent.click(screen.getByText('reviewer'));
  // The edit / delete entries live behind the header's "..." menu.
  const menuButton = [...document.querySelectorAll('button')].find((b) =>
    /ellipsis|more-horizontal/.test(b.querySelector('svg')?.getAttribute('class') ?? ''),
  );
  fireEvent.click(menuButton!);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(agentRegistry.getAgent).mockReturnValue(definition);
  vi.mocked(readInstalled).mockResolvedValue([]);
  usePluginStore.setState({ installed: [weather] });
  useSettingsStore.setState({ extensionsSearchQueries: { plugins: '', skills: '', mcp: '' }, disabledAgents: [] });
  // The section hydrates plugins on mount, which ends in a discovery refresh.
  // These tests seed the discovery store by hand, so keep the refresh inert.
  useDiscoveryStore.setState({ refresh: vi.fn(async () => undefined) });
});

describe('AgentsSection — plugin-contributed agent detail', () => {
  it('reports the plugin as the agent\'s origin', () => {
    useDiscoveryStore.setState({
      agents: [{ name: 'reviewer', description: 'Reviews code', source: { kind: 'plugin', plugin: 'weather@official' } }],
      skills: [],
      isLoading: false,
    });
    render(<AgentsSection />);
    fireEvent.click(screen.getByText('reviewer'));

    expect(screen.getByTestId('agent-added-by').textContent).toBe(
      format(tb().agentFromPlugin, { plugin: 'Weather Pack' }),
    );
  });

  it('still says the localized "User" source for an agent no plugin claims', () => {
    useDiscoveryStore.setState({
      agents: [{ name: 'reviewer', description: 'Reviews code' }],
      skills: [],
      isLoading: false,
    });
    render(<AgentsSection />);
    fireEvent.click(screen.getByText('reviewer'));

    expect(screen.getByTestId('agent-added-by').textContent).toBe(tb().sourceUser);
  });

  it('renders the zh-CN detail with translated source and description labels, no English literals', () => {
    setLanguage('zh-CN');
    try {
      useDiscoveryStore.setState({
        agents: [{ name: 'reviewer', description: 'Reviews code' }],
        skills: [],
        isLoading: false,
      });
      render(<AgentsSection />);
      fireEvent.click(screen.getByText('reviewer'));

      expect(screen.getByTitle('预览')).toBeTruthy();
      expect(screen.getByTitle('源码')).toBeTruthy();
      expect(screen.queryByTitle('Preview')).toBeNull();
      expect(screen.queryByTitle('Source')).toBeNull();
      expect(screen.getByText('来源')).toBeTruthy();
      expect(screen.getByTestId('agent-added-by').textContent).toBe('用户');
      expect(screen.getByText('描述')).toBeTruthy();
      expect(screen.queryByText('User')).toBeNull();
      expect(screen.queryByText('Description')).toBeNull();
    } finally {
      setLanguage('system');
    }
  });

  it('disables edit and delete, each saying why', () => {
    openDetail({
      name: 'reviewer',
      description: 'Reviews code',
      source: { kind: 'plugin', plugin: 'weather@official' },
    });

    const edit = screen.getByText(tb().agentEdit).closest('button')!;
    const remove = screen.getByText(tb().uninstall).closest('button')!;
    expect(edit.hasAttribute('disabled')).toBe(true);
    expect(edit.getAttribute('title')).toBe(tb().agentFromPluginEditDisabled);
    expect(remove.hasAttribute('disabled')).toBe(true);
    expect(remove.getAttribute('title')).toBe(tb().agentFromPluginDeleteDisabled);
  });

  it('leaves edit and delete usable for a user-authored agent', () => {
    openDetail({ name: 'reviewer', description: 'Reviews code' });

    expect(screen.getByText(tb().agentEdit).closest('button')!.hasAttribute('disabled')).toBe(false);
    expect(screen.getByText(tb().uninstall).closest('button')!.hasAttribute('disabled')).toBe(false);
  });
});

describe('AgentsSection — installed-plugin hydration', () => {
  it('resolves the plugin display name without the 插件 tab ever mounting', async () => {
    // Nothing has hydrated the store: this is a fresh app where the user opened
    // 扩展 › 代理 first. Only the section's own mount-time refresh can turn the
    // key `weather@official` into 「Weather Pack」.
    usePluginStore.setState({ installed: [] });
    vi.mocked(readInstalled).mockResolvedValue([weather]);
    useDiscoveryStore.setState({
      agents: [{ name: 'reviewer', description: 'Reviews code', source: { kind: 'plugin', plugin: 'weather@official' } }],
      skills: [],
      isLoading: false,
    });

    render(<AgentsSection />);
    fireEvent.click(screen.getByText('reviewer'));

    await waitFor(() => {
      expect(screen.getByTestId('agent-added-by').textContent).toBe(
        format(tb().agentFromPlugin, { plugin: 'Weather Pack' }),
      );
    });
    expect(vi.mocked(readInstalled)).toHaveBeenCalledWith('/Users/testuser');
  });
});

describe('AgentsSection — plugin ownership invariant', () => {
  // The predicate itself is pinned in `utils/agentSource.test.ts`; this is the
  // end-to-end complement: the entry is disabled AND
  // the handler behind it early-returns, so no path from this menu reaches the
  // filesystem for a plugin agent.
  it('removes nothing from disk when the delete entry is clicked for a plugin agent', () => {
    openDetail({
      name: 'reviewer',
      description: 'Reviews code',
      source: { kind: 'plugin', plugin: 'weather@official' },
    });

    fireEvent.click(screen.getByText(tb().uninstall).closest('button')!);

    expect(vi.mocked(fsRemove)).not.toHaveBeenCalled();
  });
});

describe('AgentsSection — the store\'s normalised source wins over the registry\'s', () => {
  // `applyPluginAgentSources` has already ruled on provenance by the time the
  // section reads the store; the registry only echoes the AGENT.md frontmatter,
  // which the user (or the `save_agent` tool) can write. Taking the raw value
  // would let a forged `source:` lock the user out of their own agent.
  it('ignores a forged plugin source the store already stripped', () => {
    vi.mocked(agentRegistry.getAgent).mockReturnValue({
      ...definition,
      source: { kind: 'plugin', plugin: 'forged@nowhere' },
    });
    openDetail({ name: 'reviewer', description: 'Reviews code' });

    expect(screen.getByTestId('agent-added-by').textContent).toBe(tb().sourceUser);
    expect(screen.getByText(tb().agentEdit).closest('button')!.hasAttribute('disabled')).toBe(false);
    const remove = screen.getByText(tb().uninstall).closest('button')!;
    expect(remove.hasAttribute('disabled')).toBe(false);

    // …and the handler behind the entry actually proceeds to the disk delete.
    fireEvent.click(remove);
    expect(vi.mocked(fsRemove)).toHaveBeenCalledWith('/Users/tester/.abu/agents/reviewer', { recursive: true });
  });

  it('still carries a backfilled source the registry never saw', () => {
    openDetail({
      name: 'reviewer',
      description: 'Reviews code',
      source: { kind: 'plugin', plugin: 'weather@official' },
    });

    expect(screen.getByTestId('agent-added-by').textContent).toBe(
      format(tb().agentFromPlugin, { plugin: 'Weather Pack' }),
    );
    expect(screen.getByText(tb().agentEdit).closest('button')!.hasAttribute('disabled')).toBe(true);
  });
});
