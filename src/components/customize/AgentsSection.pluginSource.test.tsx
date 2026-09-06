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

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SubagentDefinition, SubagentMetadata } from '@/types';
import type { InstalledPlugin } from '@/core/plugin/installedStore';

vi.mock('@/core/agent/registry', () => ({
  agentRegistry: { getAgent: vi.fn() },
}));

import { agentRegistry } from '@/core/agent/registry';
import { getI18n, format } from '@/i18n';
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
  usePluginStore.setState({ installed: [weather] });
  useSettingsStore.setState({ extensionsSearchQuery: '', disabledAgents: [] });
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

  it('still says User for an agent no plugin claims', () => {
    useDiscoveryStore.setState({
      agents: [{ name: 'reviewer', description: 'Reviews code' }],
      skills: [],
      isLoading: false,
    });
    render(<AgentsSection />);
    fireEvent.click(screen.getByText('reviewer'));

    expect(screen.getByTestId('agent-added-by').textContent).toBe('User');
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
