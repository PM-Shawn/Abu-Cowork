// @vitest-environment happy-dom
/**
 * 「我的」 for the Connectors tab. `sourceFilter="mine"` narrows the list to the
 * servers the user configured by hand: a plugin's server belongs to the package
 * that brought it, and presenting it here as the user's own would invite a
 * removal this list cannot honour. Everything that came from outside — the
 * curated catalog and plugin-contributed servers — lives in 「市场」
 * (ConnectorCatalog), so 「我的」 also drops the un-installed catalog cards.
 *
 * `prefill` is the other half of 「市场」's 「添加」: a catalog entry carries
 * env-var *keys* with empty values, so the add-server form opens filled in and
 * the user supplies the secrets — nothing is written behind their back.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { getI18n } from '@/i18n';
import type { MCPServerEntry } from '@/stores/mcpStore';
import { useMCPStore } from '@/stores/mcpStore';
import { usePluginStore } from '@/stores/pluginStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { InstalledPlugin } from '@/core/plugin/installedStore';
import type { MCPRegistryEntry } from '@/core/agent/mcpDiscovery';
import MCPSection from './MCPSection';

const tb = () => getI18n().toolbox;

const serverEntry = (name: string): MCPServerEntry => ({
  config: { name, command: 'npx', args: [], enabled: true },
  status: 'disconnected',
  tools: [],
});

const plugin = (name: string, mcpServers: string[]): InstalledPlugin => ({
  key: `market/${name}`,
  marketplace: 'market',
  name,
  version: '1.0.0',
  installedAt: '2026-01-01T00:00:00.000Z',
  contributed: { skills: [], mcpServers },
});

beforeEach(() => {
  vi.clearAllMocks();
  useMCPStore.setState({ servers: {}, isLoading: false });
  usePluginStore.setState({ installed: [] });
  useSettingsStore.setState({ extensionsSearchQuery: '' });
});

describe('MCPSection · sourceFilter="mine"', () => {
  it('keeps the servers the user configured and drops the plugin-owned ones', () => {
    useMCPStore.setState({
      servers: {
        'hand-rolled': serverEntry('hand-rolled'),
        'weather-mcp': serverEntry('weather-mcp'),
      },
    });
    usePluginStore.setState({ installed: [plugin('weather', ['weather-mcp'])] });

    render(<MCPSection sourceFilter="mine" />);
    expect(screen.getByText('hand-rolled')).toBeTruthy();
    expect(screen.queryByText('weather-mcp')).toBeNull();
  });

  it('keeps a catalog-named server the user configured themselves', () => {
    useMCPStore.setState({ servers: { github: serverEntry('github') } });
    render(<MCPSection sourceFilter="mine" />);
    expect(screen.getByText('github')).toBeTruthy();
  });

  it('says 还没有你添加的连接器 when every server came from a plugin', () => {
    useMCPStore.setState({ servers: { 'weather-mcp': serverEntry('weather-mcp') } });
    usePluginStore.setState({ installed: [plugin('weather', ['weather-mcp'])] });

    render(<MCPSection sourceFilter="mine" />);
    expect(screen.getByText(tb().connectorsMineEmptyTitle)).toBeTruthy();
  });

  it('drops the un-installed catalog cards — 「市场」 owns those now', () => {
    render(<MCPSection sourceFilter="mine" />);
    expect(screen.getByText(tb().connectorsMineEmptyTitle)).toBeTruthy();
    expect(screen.queryByText(tb().exampleServers)).toBeNull();
  });

  it('still shows every source when no filter is given', () => {
    useMCPStore.setState({
      servers: {
        'hand-rolled': serverEntry('hand-rolled'),
        'weather-mcp': serverEntry('weather-mcp'),
      },
    });
    usePluginStore.setState({ installed: [plugin('weather', ['weather-mcp'])] });

    render(<MCPSection />);
    expect(screen.getByText('hand-rolled')).toBeTruthy();
    expect(screen.getByText('weather-mcp')).toBeTruthy();
  });
});

describe('MCPSection · prefill', () => {
  const entry: MCPRegistryEntry = {
    name: 'github',
    keywords: ['github'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ignored-sample-value' },
  };

  it('fills the add-server form from the catalog entry, secrets left blank', async () => {
    render(<MCPSection sourceFilter="mine" showAddForm prefill={entry} />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('github')).toBeTruthy();
    });
    expect(screen.getByDisplayValue('-y @modelcontextprotocol/server-github')).toBeTruthy();
    expect(screen.getByDisplayValue('{"GITHUB_PERSONAL_ACCESS_TOKEN":""}')).toBeTruthy();
  });

  it('adds nothing on its own — the user still has to save', () => {
    const addServer = vi.spyOn(useMCPStore.getState(), 'addServer');
    render(<MCPSection sourceFilter="mine" showAddForm prefill={entry} />);
    expect(addServer).not.toHaveBeenCalled();
    expect(useMCPStore.getState().servers.github).toBeUndefined();
  });

  it('leaves the form alone while it is closed', () => {
    render(<MCPSection sourceFilter="mine" showAddForm={false} prefill={entry} />);
    expect(screen.queryByDisplayValue('github')).toBeNull();
  });
});

describe('MCPSection · focusServer', () => {
  it('opens the detail for the named server so 「市场」的 管理 lands somewhere', async () => {
    useMCPStore.setState({ servers: { 'hand-rolled': serverEntry('hand-rolled') } });
    render(<MCPSection sourceFilter="mine" focusServer="hand-rolled" />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'hand-rolled' })).toBeTruthy());
  });

  it('ignores a server that is not configured', () => {
    render(<MCPSection sourceFilter="mine" focusServer="never-existed" />);
    expect(screen.queryByRole('heading')).toBeNull();
  });
});
