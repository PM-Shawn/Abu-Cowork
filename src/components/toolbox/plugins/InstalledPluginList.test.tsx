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

import type { ReactElement } from 'react';
import { act, cleanup, render as renderBare, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, onTestFinished, vi, beforeEach } from 'vitest';
import { Button } from '@/components/ds/button';
import { DesignSystemProvider } from '@/components/ds/provider';

// The detail window and the uninstall question are design-system layers, so the list renders inside the provider like the app does.
const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

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
  usePluginStore.setState({ marketplaces: [], installed: [weather], activationByKey: {}, loading: false, error: null });
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

    it('lists marketplace installs wherever they came from, and leaves authored installs to the authored list', () => {
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

    it('puts what the user created here in the same list, under no heading of its own', () => {
      render(
        <InstalledPluginList home="/Users/tester" searchQuery="" childCount={1} onBrowseMarketplace={vi.fn()}>
          <div data-testid="plugin-mine-row">my-plugin</div>
        </InstalledPluginList>,
      );
      const rows = screen.getAllByTestId('plugin-mine-row');
      expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining('weather'), 'my-plugin']);
    });

    it('is not called empty while what the user created here fills it', () => {
      usePluginStore.setState({ installed: [] });
      render(
        <InstalledPluginList home="/Users/tester" searchQuery="" childCount={1} onBrowseMarketplace={vi.fn()}>
          <div data-testid="plugin-mine-row">my-plugin</div>
        </InstalledPluginList>,
      );
      expect(screen.queryByText(tb().pluginsEmptyState)).toBeNull();
      expect(screen.getByTestId('plugin-mine-row')).toBeInTheDocument();
    });
  });
});

describe('InstalledPluginList: what each control is called, and where the focus goes', () => {
  // A window that is still open when a test ends hands its focus back one tick after it is
  // unmounted; that tick must not land in the next test.
  afterEach(async () => {
    cleanup();
    await act(async () => {});
  });

  const radar: InstalledPlugin = { ...weather, key: 'radar@official', name: 'radar' };
  const storm: InstalledPlugin = { ...weather, key: 'storm@official', name: 'storm' };
  const cardOf = (name: string) => within(screen.getAllByTestId('plugin-mine-row').find((row) => row.textContent?.includes(name))!).getAllByRole('button')[0];
  const uninstallButton = (name: string) => screen.getByRole('button', { name: `${tb().pluginsUninstall}: ${name}` });
  const answer = async (name: RegExp) => {
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name }));
    await act(async () => {});
  };
  /** The store drops the record, as a finished uninstall does. */
  const finishUninstall = (key: string) => act(() => {
    usePluginStore.setState({ installed: usePluginStore.getState().installed.filter((plugin) => plugin.key !== key) });
  });

  it('says the shelf is empty with a title, the two ways to fill it and the way into the market', () => {
    usePluginStore.setState({ installed: [] });
    const onBrowse = vi.fn();
    render(<InstalledPluginList home="/Users/tester" searchQuery="" onBrowseMarketplace={onBrowse} />);
    expect(screen.getByText(tb().pluginsEmptyState)).toHaveClass('text-title');
    expect(screen.getByText(tb().pluginsMineEmptyHint)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: tb().pluginsGoToMarketplace }));
    expect(onBrowse).toHaveBeenCalledTimes(1);
  });

  it('says nothing matches when the search hides every install, without the way into the market', () => {
    renderList('nothing-matches');
    expect(screen.getByText(tb().pluginsNoMatches)).toHaveClass('text-title');
    expect(screen.queryByText(tb().pluginsMineEmptyHint)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  const enabledWeather = { [weather.key]: { enabled: true, root: '/Users/tester/.abu/plugin-packages/official/weather/1.2.0', skillDirs: [], legacySkills: true, agentFiles: [], mcpServers: ['weather-mcp'] } };

  it('names the uninstall button and the switch after the plugin', () => {
    usePluginStore.setState({ activationByKey: enabledWeather });
    renderList();
    expect(uninstallButton('weather')).toHaveTextContent(tb().pluginsUninstall);
    expect(uninstallButton('weather').className).toContain('text-danger');
    expect(screen.getByRole('switch', { name: 'weather' })).toHaveAttribute('aria-checked', 'true');
  });

  it('a press on the uninstall button or on the switch does not open the card', () => {
    usePluginStore.setState({ activationByKey: enabledWeather, setPluginEnabled: vi.fn().mockResolvedValue(undefined) });
    renderList();
    fireEvent.click(screen.getByRole('switch', { name: 'weather' }));
    expect(usePluginStore.getState().setPluginEnabled).toHaveBeenCalledExactlyOnceWith(weather.key, false);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(uninstallButton('weather'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the detail as a window named after the plugin', () => {
    renderList();
    fireEvent.click(cardOf('weather'));
    expect(screen.getByRole('dialog')).toHaveAccessibleName('weather');
    expect(screen.getByRole('heading', { level: 2, name: new RegExp(`^weather ${tb().plugins}$`) })).toBeInTheDocument();
  });

  it('after an uninstall the focus goes to the card that took the place of the removed one', async () => {
    usePluginStore.setState({ installed: [weather, radar, storm] });
    vi.mocked(uninstallPlugin).mockReturnValue(new Promise(() => {}));
    renderList();
    uninstallButton('radar').focus();
    fireEvent.click(uninstallButton('radar'));
    await answer(/^(Uninstall|卸载)$/);
    await finishUninstall(radar.key);

    expect(screen.getAllByTestId('plugin-mine-row')).toHaveLength(2);
    expect(cardOf('storm')).toHaveFocus();
  });

  it('after the last card of the grid is uninstalled the focus goes to the one before it', async () => {
    usePluginStore.setState({ installed: [weather, radar] });
    vi.mocked(uninstallPlugin).mockReturnValue(new Promise(() => {}));
    renderList();
    uninstallButton('radar').focus();
    fireEvent.click(uninstallButton('radar'));
    await answer(/^(Uninstall|卸载)$/);
    await finishUninstall(radar.key);

    expect(cardOf('weather')).toHaveFocus();
  });

  it('after the only plugin is uninstalled the focus goes to the way into the market', async () => {
    vi.mocked(uninstallPlugin).mockReturnValue(new Promise(() => {}));
    renderList();
    uninstallButton('weather').focus();
    fireEvent.click(uninstallButton('weather'));
    await answer(/^(Uninstall|卸载)$/);
    await finishUninstall(weather.key);

    expect(screen.getByRole('button', { name: tb().pluginsGoToMarketplace })).toHaveFocus();
  });

  it('uninstalling from the detail window gives the focus to the card when the question is cancelled', async () => {
    // The question opens with nothing focused (its window has just gone) and hands the focus back
    // to the page body when it closes. A browser ignores focus() on the body; happy-dom moves the focus there.
    const bodyFocus = vi.spyOn(document.body, 'focus').mockImplementation(() => {});
    onTestFinished(() => bodyFocus.mockRestore());
    usePluginStore.setState({ installed: [weather, radar] });
    renderList();
    cardOf('radar').focus();
    fireEvent.click(cardOf('radar'));
    // A real press focuses the button it lands on.
    const uninstallInWindow = within(screen.getByRole('dialog')).getByRole('button', { name: tb().pluginsUninstall });
    uninstallInWindow.focus();
    fireEvent.click(uninstallInWindow);
    await answer(/^(Cancel|取消)$/);

    expect(uninstallPlugin).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(cardOf('radar')).toHaveFocus();
  });

  it('leaves the focus where the user put it while the uninstall was running', async () => {
    usePluginStore.setState({ installed: [weather, radar] });
    vi.mocked(uninstallPlugin).mockReturnValue(new Promise(() => {}));
    renderBare(
      <DesignSystemProvider>
        <Button>Elsewhere</Button>
        <InstalledPluginList home="/Users/tester" searchQuery="" onBrowseMarketplace={vi.fn()} />
      </DesignSystemProvider>,
    );
    vi.useFakeTimers();
    try {
      uninstallButton('radar').focus();
      fireEvent.click(uninstallButton('radar'));
      await answer(/^(Uninstall|卸载)$/);
      // The question has gone and has handed the focus back to the button it was asked from.
      act(() => { vi.runOnlyPendingTimers(); });
      expect(uninstallButton('radar')).toHaveFocus();
      screen.getByRole('button', { name: 'Elsewhere' }).focus();
      await finishUninstall(radar.key);

      expect(screen.getByRole('button', { name: 'Elsewhere' })).toHaveFocus();
    } finally {
      vi.useRealTimers();
    }
  });
});
