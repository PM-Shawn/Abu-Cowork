// @vitest-environment happy-dom
/**
 * Uninstall deletes a package directory and withdraws its skills and MCP
 * servers — it must never be one click away. These tests pin the second
 * confirmation and the fact that the confirmation names what disappears.
 *
 * They also pin the 「已安装」 contract: every personal marketplace install is
 * listed, whatever market it came from, while authored installs and
 * organization installs belong to other surfaces.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/core/plugin/uninstaller', () => ({ uninstallPlugin: vi.fn() }));
vi.mock('@/core/plugin/installedStore', () => ({
  readInstalled: vi.fn().mockResolvedValue([]),
  // The store reads through the result variant so a failed read cannot pass
  // for an empty one (pluginStore module doc).
  readInstalledResult: vi.fn().mockResolvedValue({ ok: true, plugins: [] }),
  upsertInstalled: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/core/permissions/pluginToolPolicy', () => ({ setPluginServerNames: vi.fn() }));

import { uninstallPlugin } from '@/core/plugin/uninstaller';
import type { InstalledPlugin } from '@/core/plugin/installedStore';
import { getI18n } from '@/i18n';
import { usePluginStore } from '@/stores/pluginStore';
import InstalledPluginList from './InstalledPluginList';

const weather: InstalledPlugin = {
  key: 'weather@official',
  marketplace: 'official',
  name: 'weather',
  version: '1.2.0',
  installedAt: '2026-08-31T00:00:00.000Z',
  contributed: { skills: ['forecast', 'radar'], mcpServers: ['weather-mcp'], agents: [], teams: [] },
};

/** Locale-resolved toolbox strings — these tests run under either locale. */
const tb = () => getI18n().toolbox;

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
  it('shows name and contributions without the card version', () => {
    renderList();
    const row = screen.getByTestId('plugin-mine-row');
    expect(row).toHaveTextContent('weather');
    expect(row).not.toHaveTextContent('v1.2.0');
    expect(row).toHaveTextContent('official');
    expect(row).toHaveTextContent('2');
    expect(row).toHaveTextContent('1');
  });

  it('requires a second confirmation before uninstalling', async () => {
    renderList();

    fireEvent.click(screen.getByRole('button', { name: /weather$/ }));
    // Confirmation is up; nothing removed yet.
    expect(uninstallPlugin).not.toHaveBeenCalled();
    // The dialog names the collateral (2 skills, 1 connector, 0 agents), not
    // just the plugin — uninstall withdraws all three.
    expect(document.body.textContent).toMatch(
      /2 skills, 1 connectors and 0 experts|2 个技能、1 个连接器和 0 个专家/,
    );

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
    expect(screen.queryByTestId('plugin-mine-row')).toBeNull();
  });

  it('offers a way into the marketplace when nothing is installed', () => {
    usePluginStore.setState({ installed: [] });
    renderList();
    expect(screen.queryByTestId('plugin-mine-row')).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('hides organization (enterprise-market) installs from the personal list', () => {
    const orgPlugin: InstalledPlugin = {
      key: 'compliance-bot@enterprise',
      marketplace: 'enterprise',
      name: 'compliance-bot',
      version: '3.0.0',
      installedAt: '2026-09-01T00:00:00.000Z',
      contributed: { skills: ['audit'], mcpServers: [], agents: [], teams: [] },
    };
    usePluginStore.setState({ installed: [weather, orgPlugin] });
    renderList();
    const rows = screen.getAllByTestId('plugin-mine-row');
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
          contributed: { skills: ['audit'], mcpServers: [], agents: [], teams: [] },
        },
      ],
    });
    renderList();

    expect(screen.queryByTestId('plugin-mine-row')).toBeNull();
    expect(screen.getByText(/No plugins installed yet|还没有安装任何插件/)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /Browse the marketplace|去插件市场看看/ }),
    ).toBeTruthy();
    expect(screen.queryByText(/No plugins match|没有匹配的插件/)).toBeNull();
  });

  describe('what counts as installed', () => {
    /** Fetched from someone else's repo — installed, so the user has it. */
    const remoteInstall: InstalledPlugin = {
      key: 'cloud-thing@official',
      marketplace: 'official',
      name: 'cloud-thing',
      version: '2.0.0',
      sha: 'abc123',
      sourceKind: 'git-subdir',
      installedAt: '2026-09-01T00:00:00.000Z',
      contributed: { skills: [], mcpServers: [], agents: [], teams: [] },
    };
    /** Created here: shown by AuthoredPluginList with its draft, never twice. */
    const authored: InstalledPlugin = {
      key: 'my-plugin@author-1',
      marketplace: 'author-1',
      name: 'my-plugin',
      version: '0.1.0',
      authoringId: '1',
      sourceKind: 'relative',
      installedAt: '2026-09-02T00:00:00.000Z',
      contributed: { skills: ['draft'], mcpServers: [], agents: [], teams: [] },
    };

    it('lists marketplace installs wherever they came from, and leaves authored installs to their own group', () => {
      usePluginStore.setState({ installed: [remoteInstall, authored, weather] });
      renderList();
      const rows = screen.getAllByTestId('plugin-mine-row');
      expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining('cloud-thing'), expect.stringContaining('weather')]);
      expect(screen.queryByText('my-plugin')).toBeNull();
    });

    it('shows the installed empty state, with the marketplace offered, when only authored installs exist', () => {
      usePluginStore.setState({ installed: [authored] });
      renderList();
      expect(screen.queryByTestId('plugin-mine-row')).toBeNull();
      expect(screen.getByText(tb().pluginsEmptyState)).toBeInTheDocument();
      expect(screen.getByText(tb().pluginsGoToMarketplace)).toBeInTheDocument();
    });

    it('renders as a titled group inside the 「我的」 shelf', () => {
      render(<InstalledPluginList home="/Users/tester" searchQuery="" grouped onBrowseMarketplace={vi.fn()} />);
      const group = screen.getByTestId('plugin-installed-group');
      expect(group).toHaveTextContent(tb().pluginsInstalledGroup);
      expect(group).toHaveTextContent('weather');
    });
  });
});
