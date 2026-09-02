// @vitest-environment happy-dom
/**
 * Uninstall deletes a package directory and withdraws its skills and MCP
 * servers — it must never be one click away. These tests pin the second
 * confirmation and the fact that the confirmation names what disappears.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/core/plugin/uninstaller', () => ({ uninstallPlugin: vi.fn() }));
vi.mock('@/core/plugin/installedStore', () => ({
  readInstalled: vi.fn().mockResolvedValue([]),
  upsertInstalled: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/core/plugin/skillRoots', () => ({ pluginMcpServerNames: vi.fn().mockResolvedValue([]) }));
vi.mock('@/core/permissions/pluginToolPolicy', () => ({ setPluginServerNames: vi.fn() }));

import { uninstallPlugin } from '@/core/plugin/uninstaller';
import type { InstalledPlugin } from '@/core/plugin/installedStore';
import { usePluginStore } from '@/stores/pluginStore';
import InstalledPluginList from './InstalledPluginList';

const weather: InstalledPlugin = {
  key: 'weather@official',
  marketplace: 'official',
  name: 'weather',
  version: '1.2.0',
  installedAt: '2026-08-31T00:00:00.000Z',
  contributed: { skills: ['forecast', 'radar'], mcpServers: ['weather-mcp'] },
};

function renderList(searchQuery = '') {
  render(
    <InstalledPluginList
      home="/Users/tester"
      searchQuery={searchQuery}
      onBrowseMarketplace={vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  usePluginStore.setState({ marketplaces: [], installed: [weather], loading: false, error: null });
  vi.mocked(uninstallPlugin).mockResolvedValue({
    key: weather.key,
    withdrawn: { skills: ['forecast', 'radar'], mcpServers: ['weather-mcp'] },
  });
});

describe('InstalledPluginList', () => {
  it('shows the name, version, source marketplace and what the plugin contributed', () => {
    renderList();
    const row = screen.getByTestId('installed-plugin-row');
    expect(row).toHaveTextContent('weather');
    expect(row).toHaveTextContent('v1.2.0');
    expect(row).toHaveTextContent('official');
    expect(row).toHaveTextContent('2');
    expect(row).toHaveTextContent('1');
  });

  it('requires a second confirmation before uninstalling', async () => {
    renderList();

    fireEvent.click(screen.getByRole('button', { name: /weather$/ }));
    // Confirmation is up; nothing removed yet.
    expect(uninstallPlugin).not.toHaveBeenCalled();
    // The dialog names the collateral (2 skills, 1 connector), not just the plugin.
    expect(document.body.textContent).toMatch(/2 skills and 1 connectors|2 个技能和 1 个连接器/);

    fireEvent.click(screen.getByRole('button', { name: /^(Uninstall|卸载)$/ }));
    await waitFor(() => expect(uninstallPlugin).toHaveBeenCalledTimes(1));
    expect(vi.mocked(uninstallPlugin).mock.calls[0][0]).toMatchObject({
      home: '/Users/tester',
      key: 'weather@official',
    });
  });

  it('removes nothing when the confirmation is cancelled', async () => {
    renderList();

    fireEvent.click(screen.getByRole('button', { name: /weather$/ }));
    fireEvent.click(screen.getByRole('button', { name: /^(Cancel|取消)$/ }));

    await waitFor(() => expect(screen.queryByText(/Uninstall plugin|卸载插件/)).toBeNull());
    expect(uninstallPlugin).not.toHaveBeenCalled();
  });

  it('filters by the shared search query', () => {
    renderList('nothing-matches');
    expect(screen.queryByTestId('installed-plugin-row')).toBeNull();
  });

  it('offers a way into the marketplace when nothing is installed', () => {
    usePluginStore.setState({ installed: [] });
    renderList();
    expect(screen.queryByTestId('installed-plugin-row')).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('hides organization (enterprise-market) installs from the personal list', () => {
    const orgPlugin: InstalledPlugin = {
      key: 'compliance-bot@enterprise',
      marketplace: 'enterprise',
      name: 'compliance-bot',
      version: '3.0.0',
      installedAt: '2026-09-01T00:00:00.000Z',
      contributed: { skills: ['audit'], mcpServers: [] },
    };
    usePluginStore.setState({ installed: [weather, orgPlugin] });
    renderList();
    const rows = screen.getAllByTestId('installed-plugin-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('weather');
    expect(screen.queryByText('compliance-bot')).toBeNull();
  });

  it('shows the empty state when every install is organization-scoped', () => {
    // Personal list empty but `installed` non-empty: the gate must key off the
    // personal partition, otherwise the user is told "no matches" (as if their
    // search was too narrow) instead of being offered the marketplace.
    usePluginStore.setState({
      installed: [
        {
          key: 'compliance-bot@enterprise',
          marketplace: 'enterprise',
          name: 'compliance-bot',
          version: '3.0.0',
          installedAt: '2026-09-01T00:00:00.000Z',
          contributed: { skills: ['audit'], mcpServers: [] },
        },
      ],
    });
    renderList();

    expect(screen.queryByTestId('installed-plugin-row')).toBeNull();
    expect(screen.getByText(/No plugins installed yet|还没有安装任何插件/)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /Browse the marketplace|去插件市场看看/ }),
    ).toBeTruthy();
    expect(screen.queryByText(/No plugins match|没有匹配的插件/)).toBeNull();
  });
});
