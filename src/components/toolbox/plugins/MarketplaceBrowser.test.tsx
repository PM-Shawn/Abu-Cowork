// @vitest-environment happy-dom
/**
 * The invariant under test: browsing a marketplace can *plan* an install, but
 * no plugin is installed or registered until the user confirms the disclosure. A
 * regression here would mean third-party executables land on disk from a
 * single click, with the disclosure reduced to decoration.
 */

import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

/** A promise whose resolution this test controls, to drive plan ordering. */
function makeDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Only the disk read is faked — `expandHome` stays real, because the store's
// scan calls it on every market dir.
vi.mock('@/core/plugin/loadMarketplace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/plugin/loadMarketplace')>()),
  loadMarketplaceFromDir: vi.fn(),
}));
vi.mock('@/core/plugin/installer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/plugin/installer')>()),
  planInstall: vi.fn(),
  installPlugin: vi.fn(),
  releasePreparedInstall: vi.fn().mockResolvedValue(undefined),
  validatePreparedInstall: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/core/plugin/installedStore', () => ({
  readInstalled: vi.fn().mockResolvedValue([]),
  // The store reads through the result variant so a failed read cannot pass
  // for an empty one (pluginStore module doc).
  readInstalledResult: vi.fn().mockResolvedValue({ ok: true, plugins: [] }),
  upsertInstalled: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/core/plugin/uninstaller', () => ({ uninstallPlugin: vi.fn() }));
vi.mock('@/core/permissions/pluginToolPolicy', () => ({ setPluginServerNames: vi.fn() }));
// happy-dom gives Virtuoso a zero-size viewport and its ResizeObserver never
// fires, so the real component mounts no rows at all. Mock it as a plain list
// (the same shape ChatView's tests use) so the row markup and the wiring —
// every entry reaches Virtuoso's `data`, keyed by `computeItemKey` — are what
// these tests exercise. Virtualization itself is verified in the real shell.
vi.mock('react-virtuoso', async () => {
  const { createElement, forwardRef } = await import('react');
  type MockVirtuosoProps = {
    data?: unknown[];
    computeItemKey?: (index: number, item: unknown) => string | number;
    itemContent?: (index: number, item: unknown) => ReturnType<typeof createElement>;
    'data-testid'?: string;
  };
  return {
    Virtuoso: forwardRef<unknown, MockVirtuosoProps>(function MockVirtuoso(
      { data = [], computeItemKey, itemContent, 'data-testid': testId },
      _ref,
    ) {
      return createElement(
        'div',
        { 'data-testid': testId ?? 'mock-virtuoso', 'data-item-count': data.length },
        data.map((item, index) => createElement(
          'div',
          { key: computeItemKey?.(index, item) ?? index },
          itemContent?.(index, item),
        )),
      );
    }),
  };
});

import {
  planInstall,
  installPlugin,
  releasePreparedInstall,
  UnsupportedSourceError,
  type InstallDisclosure,
} from '@/core/plugin/installer';
import { PluginSymlinkRootError } from '@/core/plugin/fsOps';
import { uninstallPlugin } from '@/core/plugin/uninstaller';
import type { InstalledPlugin } from '@/core/plugin/installedStore';
import { format, getI18n } from '@/i18n';
import type { Marketplace, MarketplaceEntry } from '@/core/plugin/marketplace';
import { usePluginStore } from '@/stores/pluginStore';
import { loadMarketplaceFromDir } from '@/core/plugin/loadMarketplace';
import MarketplaceBrowser from './MarketplaceBrowser';

const localEntry: MarketplaceEntry = {
  name: 'weather',
  version: '1.0.0',
  description: 'Local forecast tools',
  category: 'productivity',
  source: { kind: 'relative', path: './plugins/weather' },
};

const remoteEntry: MarketplaceEntry = {
  name: 'cloud-thing',
  description: 'Hosted somewhere else',
  category: 'development',
  source: { kind: 'git-subdir', url: 'https://github.com/x/y', path: 'plugins/cloud-thing' },
};

const marketplace: Marketplace = {
  name: 'official',
  plugins: [localEntry, remoteEntry],
};

const disclosure: InstallDisclosure = {
  preparedToken: 'test-prepared-token',
  key: 'weather@official',
  name: 'weather',
  marketplace: 'official',
  version: '1.0.0',
  manifest: { name: 'weather', version: '1.0.0' } as InstallDisclosure['manifest'],
  sourceDir: '/m/official/plugins/weather',
  skills: ['forecast'],
  mcpServers: [{ name: 'weather-mcp', command: 'npx', args: ['-y', '@acme/weather-mcp'] }],
  agents: [],
  ignoredPayloads: [],
};

const installedWeather: InstalledPlugin = {
  key: 'weather@official',
  marketplace: 'official',
  name: 'weather',
  version: '1.0.0',
  installedAt: '2026-08-31T00:00:00.000Z',
  contributed: { skills: ['forecast'], mcpServers: ['weather-mcp'], agents: [] },
};

/** Locale-resolved toolbox strings — these tests run under either locale. */
const tb = () => getI18n().toolbox;

function renderBrowser() {
  return render(
    <MarketplaceBrowser home="/Users/tester" searchQuery="" onAddMarketplace={vi.fn()} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  usePluginStore.setState({
    marketplaces: [{ name: 'official', dir: '/m/official' }],
    installed: [],
    activationByKey: {},
    activationReady: true,
    loading: false,
    error: null,
  });
  vi.mocked(loadMarketplaceFromDir).mockResolvedValue(marketplace);
  vi.mocked(uninstallPlugin).mockResolvedValue({
    key: 'weather@official',
    withdrawn: { skills: [], mcpServers: [] },
  });
  vi.mocked(planInstall).mockResolvedValue(disclosure);
  // installPlugin now returns { record, mcpServers } (single-plan outcome).
  vi.mocked(installPlugin).mockResolvedValue({
    record: {
      key: `${disclosure.name}@official`,
      marketplace: 'official',
      name: disclosure.name,
      version: disclosure.version ?? '0.0.0',
      installedAt: '2026-09-01T00:00:00.000Z',
      contributed: { skills: disclosure.skills, mcpServers: disclosure.mcpServers.map((s) => s.name), agents: [] },
    },
    mcpServers: disclosure.mcpServers,
  });
});

describe('MarketplaceBrowser', () => {
  it('lists the marketplace entries', async () => {
    renderBrowser();
    await waitFor(() => expect(screen.getAllByTestId('plugin-marketplace-entry')).toHaveLength(2));
    expect(screen.getByText('weather')).toBeInTheDocument();
    expect(screen.getByText('cloud-thing')).toBeInTheDocument();
  });

  it('filters entries by the shared toolbox search query', async () => {
    const { rerender } = render(
      <MarketplaceBrowser home="/Users/tester" searchQuery="" onAddMarketplace={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getAllByTestId('plugin-marketplace-entry')).toHaveLength(2));

    // 291 real entries make search the only usable way in — match on
    // description text too, not just the name.
    rerender(
      <MarketplaceBrowser home="/Users/tester" searchQuery="forecast" onAddMarketplace={vi.fn()} />,
    );
    const rows = screen.getAllByTestId('plugin-marketplace-entry');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('weather');
  });

  it('plans on click but does NOT install until the disclosure is confirmed', async () => {
    renderBrowser();
    await waitFor(() => expect(screen.getAllByTestId('plugin-marketplace-entry')).toHaveLength(2));

    fireEvent.click(screen.getByRole('button', { name: /weather$/ }));

    await waitFor(() => expect(screen.getByTestId('plugin-install-confirm')).toBeInTheDocument());
    expect(planInstall).toHaveBeenCalledTimes(1);
    // The disclosure is on screen and nothing has been written yet.
    expect(installPlugin).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('plugin-install-confirm'));
    await waitFor(() => expect(installPlugin).toHaveBeenCalledTimes(1));
    expect(vi.mocked(installPlugin).mock.calls[0][0]).toMatchObject({
      home: '/Users/tester',
      marketplaceName: 'official',
      marketplaceDir: '/m/official',
      entry: localEntry,
      preparedToken: 'test-prepared-token',
    });
  });

  it('does not let a superseded plan resolution overwrite the current disclosure', async () => {
    // A single flow drives both "which entry is pending" and "what its plan
    // says". If those were two independent states with no staleness guard, a
    // plan request the user has already moved on from could resolve late and
    // paint its data over the entry now on screen — the user would confirm one
    // plugin while reading another plugin's command line.
    const deferredWeather = makeDeferred<InstallDisclosure>();
    const deferredCloud = makeDeferred<InstallDisclosure>();
    const weatherPlan: InstallDisclosure = {
      ...disclosure,
      name: 'weather',
      mcpServers: [{ name: 'weather-mcp', command: 'npx', args: ['-y', '@acme/weather-mcp'] }],
    };
    const cloudPlan: InstallDisclosure = {
      ...disclosure,
      preparedToken: 'cloud-prepared-token',
      key: 'cloud-thing@official',
      name: 'cloud-thing',
      sourceDir: '/m/official/plugins/cloud-thing',
      mcpServers: [{ name: 'cloud-mcp', command: 'node', args: ['cloud.js'] }],
    };
    vi.mocked(planInstall).mockImplementation((opts) =>
      opts.entry.name === 'weather' ? deferredWeather.promise : deferredCloud.promise,
    );

    renderBrowser();
    await waitFor(() => expect(screen.getAllByTestId('plugin-marketplace-entry')).toHaveLength(2));

    // Plan weather, then abandon it before it resolves.
    fireEvent.click(screen.getByRole('button', { name: /weather$/ }));
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('plugin-install-disclosure')).toBeNull());

    // Now plan cloud-thing and let *its* plan resolve.
    fireEvent.click(screen.getByRole('button', { name: /cloud-thing$/ }));
    deferredCloud.resolve(cloudPlan);
    await waitFor(() => expect(screen.getByTestId('plugin-install-confirm')).toBeInTheDocument());
    const dialog = screen.getByTestId('plugin-install-disclosure');
    expect(dialog).toHaveTextContent('cloud-mcp');

    // The abandoned weather plan resolves late. It must be dropped, not painted
    // over the cloud-thing disclosure the user is currently reading.
    await act(async () => {
      deferredWeather.resolve(weatherPlan);
      await Promise.resolve();
    });
    expect(dialog).toHaveTextContent('cloud-mcp');
    expect(dialog).not.toHaveTextContent('weather-mcp');
    expect(releasePreparedInstall).toHaveBeenCalledWith(weatherPlan.preparedToken);
    expect(releasePreparedInstall).not.toHaveBeenCalledWith(cloudPlan.preparedToken);
  });

  it('gates the confirm button on the current plan, never a leftover ready one', async () => {
    const first = makeDeferred<InstallDisclosure>();
    const second = makeDeferred<InstallDisclosure>();
    const deferreds = [first, second];
    let call = 0;
    vi.mocked(planInstall).mockImplementation(() => deferreds[call++].promise);

    renderBrowser();
    await waitFor(() => expect(screen.getAllByTestId('plugin-marketplace-entry')).toHaveLength(2));

    // Plan and install the first entry to completion. This is the path that
    // used to leave a `ready` plan behind after the dialog closed.
    fireEvent.click(screen.getByRole('button', { name: /weather$/ }));
    expect(screen.queryByTestId('plugin-install-confirm')).toBeNull(); // still planning
    await act(async () => {
      first.resolve(disclosure);
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId('plugin-install-confirm')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('plugin-install-confirm'));
    await waitFor(() => expect(installPlugin).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId('plugin-install-disclosure')).toBeNull());

    // Opening the next plan must present a loading dialog, not flash a
    // confirm button carried over from the install that just finished.
    fireEvent.click(screen.getByRole('button', { name: /cloud-thing$/ }));
    expect(screen.getByTestId('plugin-install-disclosure')).toBeInTheDocument();
    expect(screen.queryByTestId('plugin-install-confirm')).toBeNull();
    await act(async () => {
      second.resolve({ ...disclosure, key: 'cloud-thing@official', name: 'cloud-thing' });
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId('plugin-install-confirm')).toBeInTheDocument());
  });

  it('installs nothing when the user dismisses the disclosure', async () => {
    renderBrowser();
    await waitFor(() => expect(screen.getAllByTestId('plugin-marketplace-entry')).toHaveLength(2));

    fireEvent.click(screen.getByRole('button', { name: /weather$/ }));
    await waitFor(() => expect(screen.getByTestId('plugin-install-confirm')).toBeInTheDocument());

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('plugin-install-disclosure')).toBeNull());
    expect(installPlugin).not.toHaveBeenCalled();
    expect(releasePreparedInstall).toHaveBeenCalledWith('test-prepared-token');
  });

  it('releases the prepared token when the marketplace component unmounts', async () => {
    const browser = renderBrowser();
    await waitFor(() => expect(screen.getAllByTestId('plugin-marketplace-entry')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: /weather$/ }));
    await screen.findByTestId('plugin-install-confirm');
    browser.unmount();
    expect(releasePreparedInstall).toHaveBeenCalledWith('test-prepared-token');
    expect(installPlugin).not.toHaveBeenCalled();
  });

  it('consumes a prepared confirmation only once while installation is pending', async () => {
    const pending = makeDeferred<Awaited<ReturnType<typeof installPlugin>>>();
    vi.mocked(installPlugin).mockReturnValue(pending.promise);
    renderBrowser();
    await waitFor(() => expect(screen.getAllByTestId('plugin-marketplace-entry')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: /weather$/ }));
    const confirm = await screen.findByTestId('plugin-install-confirm');
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(installPlugin).toHaveBeenCalledTimes(1));
    await act(async () => { pending.resolve({ record: installedWeather, mcpServers: [] }); });
    await waitFor(() => expect(screen.queryByTestId('plugin-install-disclosure')).toBeNull());
    expect(releasePreparedInstall).toHaveBeenCalledWith('test-prepared-token');
  });

  it('keeps the catalog card compact and opens remote install disclosure', async () => {
    renderBrowser();
    await waitFor(() => expect(screen.getAllByTestId('plugin-marketplace-entry')).toHaveLength(2));

    expect(screen.queryByTestId('plugin-remote-source-badge')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /cloud-thing$/ }));
    await screen.findByTestId('plugin-install-confirm');
    expect(planInstall).toHaveBeenCalledWith(expect.objectContaining({ entry: remoteEntry }));
    expect(installPlugin).not.toHaveBeenCalled();
  });

  it('explains an unsupported remote source instead of blowing up', async () => {
    vi.mocked(planInstall).mockRejectedValue(new UnsupportedSourceError('git-subdir'));
    renderBrowser();
    await waitFor(() => expect(screen.getAllByTestId('plugin-marketplace-entry')).toHaveLength(2));

    fireEvent.click(screen.getByRole('button', { name: /cloud-thing$/ }));

    const notice = await screen.findByTestId('plugin-unsupported-notice');
    expect(notice.textContent).toContain('cloud-thing');
    expect(screen.queryByTestId('plugin-install-confirm')).toBeNull();
    expect(installPlugin).not.toHaveBeenCalled();
  });

  it('explains a package whose own folder is a link, in the user\'s language', async () => {
    // The refusal is a first-class outcome of a package we will not install,
    // not a crash — so it gets the same typed-error-to-locale-key treatment as
    // an unsupported source rather than leaking raw English from the core.
    vi.mocked(planInstall).mockRejectedValue(
      new PluginSymlinkRootError('/m/official/plugins/weather'),
    );
    renderBrowser();
    await waitFor(() => expect(screen.getAllByTestId('plugin-marketplace-entry')).toHaveLength(2));

    fireEvent.click(screen.getByRole('button', { name: /weather$/ }));

    const expected = format(getI18n().toolbox.pluginsSymlinkRootRefused, {
      path: '/m/official/plugins/weather',
    });
    expect(await screen.findByText(expected)).toBeInTheDocument();
    expect(screen.queryByText(/Refusing a plugin package/)).toBeNull();
    expect(installPlugin).not.toHaveBeenCalled();
  });

  it('replaces the install button with an inline switch on an installed entry', async () => {
    // Installed cards open details; their inline control is the master switch.
    usePluginStore.setState({ installed: [installedWeather] });
    renderBrowser();
    await waitFor(() => expect(screen.getAllByTestId('plugin-marketplace-entry')).toHaveLength(2));

    const rows = screen.getAllByTestId('plugin-marketplace-entry');
    expect(within(rows[0]).getByRole('switch')).toBeInTheDocument();
    expect(rows[0].querySelector('[data-testid="plugin-item-menu"]')).toBeNull();
    expect(rows[0].textContent).not.toContain(tb().pluginsInstall);
    // The not-installed row still gets the plain install button.
    expect(rows[1].querySelector('[data-testid="plugin-item-menu"]')).toBeNull();
    expect(rows[1].textContent).toContain(tb().pluginsInstall);
  });

  it('opens details from the card with trial and uninstall outside the source menu', async () => {
    usePluginStore.setState({ installed: [installedWeather] });
    renderBrowser();
    await waitFor(() => expect(screen.getAllByTestId('plugin-marketplace-entry')).toHaveLength(2));

    fireEvent.click(screen.getByText('weather'));
    expect(screen.getByRole('button', { name: tb().menuTrial })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: tb().pluginsUninstall })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('plugin-detail-menu'));
    expect(screen.getByRole('menuitem', { name: tb().pluginsDisclosureSource })).toBeInTheDocument();
  });

  it('uninstalls from details, but only after the confirmation', async () => {
    usePluginStore.setState({ installed: [installedWeather] });
    renderBrowser();
    await waitFor(() => expect(screen.getAllByTestId('plugin-marketplace-entry')).toHaveLength(2));

    fireEvent.click(screen.getByText('weather'));
    fireEvent.click(screen.getByRole('button', { name: tb().pluginsUninstall }));
    // Confirmation is up; nothing removed yet.
    expect(uninstallPlugin).not.toHaveBeenCalled();
    expect(screen.getByText(tb().pluginsUninstallTitle)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: `${tb().pluginsUninstall}` }));
    await waitFor(() => expect(uninstallPlugin).toHaveBeenCalledTimes(1));
    expect(vi.mocked(uninstallPlugin).mock.calls[0][0]).toMatchObject({
      home: '/Users/tester',
      key: 'weather@official',
    });
  });

  it('opens the installed record in a manage dialog', async () => {
    // Every kind of contribution the uninstaller withdraws is named here —
    // agents included, since removal deletes them from ~/.abu/agents.
    usePluginStore.setState({
      installed: [
        {
          ...installedWeather,
          contributed: { ...installedWeather.contributed, agents: ['reviewer'] },
        },
      ],
    });
    renderBrowser();
    await waitFor(() => expect(screen.getAllByTestId('plugin-marketplace-entry')).toHaveLength(2));

    fireEvent.click(screen.getByText('weather'));

    const detail = screen.getByTestId('plugin-manage-dialog');
    expect(detail).toHaveTextContent('weather');
    expect(detail).not.toHaveTextContent('official');
    expect(detail).toHaveTextContent('forecast');
    expect(detail).toHaveTextContent('weather-mcp');
    expect(detail).toHaveTextContent(tb().pluginsDisclosureAgents);
    expect(detail).toHaveTextContent('reviewer');
  });

  it('lists installs whose marketplace is gone under their own group', async () => {
    // The built-in market is present, so the marketplace list has hydrated and
    // "not in the list" genuinely means the source is gone.
    usePluginStore.setState({
      marketplaces: [
        { name: 'abu-official', dir: '/m/abu', builtin: true },
        { name: 'official', dir: '/m/official' },
      ],
      installed: [{ ...installedWeather, key: 'stale@removed', marketplace: 'removed', name: 'stale' }],
    });
    renderBrowser();
    await waitFor(() => expect(screen.getAllByTestId('plugin-marketplace-entry')).toHaveLength(2));

    const group = screen.getByTestId('plugin-orphan-group');
    expect(group).toHaveTextContent(tb().pluginsOrphanGroup);
    expect(group).toHaveTextContent('stale');
    expect(group).toHaveTextContent('removed');

    fireEvent.click(screen.getByText('stale'));
    expect(screen.getByTestId('plugin-manage-dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: tb().pluginsUninstall })).toBeInTheDocument();
  });

  it('does not guess at orphans before the marketplace list has hydrated', async () => {
    // No built-in entry yet: `marketplaces` may simply not have loaded, and
    // flagging every install as orphaned on cold start would be a lie.
    usePluginStore.setState({
      marketplaces: [{ name: 'official', dir: '/m/official' }],
      installed: [{ ...installedWeather, key: 'stale@removed', marketplace: 'removed', name: 'stale' }],
    });
    renderBrowser();
    await waitFor(() => expect(screen.getAllByTestId('plugin-marketplace-entry')).toHaveLength(2));

    expect(screen.queryByTestId('plugin-orphan-group')).toBeNull();
  });

  it('hands every entry of a large marketplace to the virtualized list', async () => {
    // The official marketplace has ~291 entries and organization catalogs
    // grow, so the ready-state list renders through Virtuoso instead of a
    // plain <ul>. With the mock above the "bounded window" of a real Virtuoso
    // cannot be observed here (happy-dom measures the viewport at 0); what
    // this pins is that all 300 entries reach the virtualized list, keyed by
    // name, with none dropped or duplicated by the extraction of the row.
    const plugins: MarketplaceEntry[] = Array.from({ length: 300 }, (_, i) => ({
      name: `plugin-${i}`,
      description: `Plugin number ${i}`,
      source: { kind: 'relative', path: `./plugins/plugin-${i}` },
    }));
    vi.mocked(loadMarketplaceFromDir).mockResolvedValue({ name: 'official', plugins });

    renderBrowser();
    const list = await screen.findByTestId('plugin-marketplace-list');
    expect(list).toHaveAttribute('data-item-count', '100');
    const rows = screen.getAllByTestId('plugin-marketplace-entry');
    expect(rows).toHaveLength(300);
    expect(rows[0]).toHaveTextContent('plugin-0');
    expect(rows[299]).toHaveTextContent('plugin-299');
    expect(list.querySelector('ul')).toBeNull();
  });

  it('surfaces a broken marketplace directory as a readable error', async () => {
    vi.mocked(loadMarketplaceFromDir).mockRejectedValue(new Error('No marketplace manifest in /m/official'));
    renderBrowser();

    expect(await screen.findByText(/No marketplace manifest in \/m\/official/)).toBeInTheDocument();
  });


  it('shows an Update button when an installed plugin has a newer marketplace version', async () => {
    usePluginStore.setState({
      installed: [{
        key: 'weather@official', marketplace: 'official', name: 'weather', version: '0.9.0',
        installedAt: '2026-09-01T00:00:00.000Z', contributed: { skills: [], mcpServers: [], agents: [] },
      }],
    });
    renderBrowser();
    await waitFor(() => expect(screen.getAllByTestId('plugin-marketplace-entry').length).toBeGreaterThan(0));
    // weather is installed at 0.9.0, marketplace offers 1.0.0 → updatable.
    // The flag arrives via the store's scan, so wait for it rather than
    // asserting on the first paint.
    await waitFor(() => expect(screen.getByTestId('plugin-update-button')).toBeInTheDocument());
  });

  it('rescans when `installed` arrives after the panel is already open', async () => {
    // The panel can be opened before the boot-time hydrate lands, and the rows
    // read their update state ONLY from the store. Without `installed` in the
    // mount effect's deps that first scan (against an empty `installed`) is the
    // last one, and every row claims to be up to date forever.
    renderBrowser();
    await waitFor(() => expect(screen.getAllByTestId('plugin-marketplace-entry').length).toBeGreaterThan(0));
    expect(screen.queryByTestId('plugin-update-button')).toBeNull();

    await act(async () => {
      usePluginStore.setState({
        installed: [{
          key: 'weather@official', marketplace: 'official', name: 'weather', version: '0.9.0',
          installedAt: '2026-09-01T00:00:00.000Z', contributed: { skills: [], mcpServers: [], agents: [] },
        }],
      });
    });
    await waitFor(() => expect(screen.getByTestId('plugin-update-button')).toBeInTheDocument());
  });

  it('scores every added market, not just the displayed one', async () => {
    // The badge is the union across markets. Browsing a second market used to
    // REPLACE the personal-scope keys, so opening a market with nothing to
    // update silently cleared an update that was still true in the first one.
    const installedAt = '2026-09-01T00:00:00.000Z';
    const contributed = { skills: [], mcpServers: [], agents: [] };
    usePluginStore.setState({
      installed: [
        { key: 'weather@official', marketplace: 'official', name: 'weather', version: '0.9.0', installedAt, contributed },
        { key: 'weather@other', marketplace: 'other', name: 'weather', version: '0.9.0', installedAt, contributed },
      ],
      updateAvailableKeys: [],
      updateAvailableCount: 0,
    });
    renderBrowser();
    await waitFor(() => expect(usePluginStore.getState().updateAvailableKeys).toEqual(['weather@official']));

    // A second market, auto-selected on arrival. Its own entries are scored
    // against its own installs — official's flag survives either way.
    const other = makeDeferred<Marketplace>();
    vi.mocked(loadMarketplaceFromDir).mockImplementation((dir) =>
      dir === '/m/other' ? other.promise : Promise.resolve(marketplace),
    );
    await act(async () => {
      usePluginStore.setState({
        marketplaces: [{ name: 'official', dir: '/m/official' }, { name: 'other', dir: '/m/other' }],
      });
    });
    await act(async () => {
      other.resolve({
        name: 'other',
        plugins: [{ name: 'weather', version: '2.0.0', source: { kind: 'relative', path: './weather' } }],
      });
    });
    await waitFor(() =>
      expect(usePluginStore.getState().updateAvailableKeys).toEqual(['weather@official', 'weather@other']),
    );
    expect(usePluginStore.getState().updateAvailableCount).toBe(2);
  });

  it('takes the row\'s Update state from the store, not a second local scoring', async () => {
    // One source of truth: the badge count and this button are the same keys.
    // A key the store does not carry must not sprout an Update button.
    usePluginStore.setState({
      installed: [{
        key: 'weather@official', marketplace: 'official', name: 'weather', version: '0.9.0',
        installedAt: '2026-09-01T00:00:00.000Z', contributed: { skills: [], mcpServers: [], agents: [] },
      }],
    });
    renderBrowser();
    await waitFor(() => expect(screen.getByTestId('plugin-update-button')).toBeInTheDocument());

    await act(async () => {
      usePluginStore.getState().setUpdateAvailableKeys([], 'personal');
    });
    expect(screen.queryByTestId('plugin-update-button')).toBeNull();
  });

  it('shows a disabled Already-installed button when versions match', async () => {
    usePluginStore.setState({
      installed: [{
        key: 'weather@official', marketplace: 'official', name: 'weather', version: '1.0.0',
        installedAt: '2026-09-01T00:00:00.000Z', contributed: { skills: [], mcpServers: [], agents: [] },
      }],
    });
    renderBrowser();
    await waitFor(() => expect(screen.getAllByTestId('plugin-marketplace-entry').length).toBeGreaterThan(0));
    expect(screen.queryByTestId('plugin-update-button')).toBeNull();
  });
});

it('retains readable rows on refresh failure and blocks stale installs until retry succeeds', async () => {
  renderBrowser();
  await screen.findByText('weather');
  vi.mocked(loadMarketplaceFromDir).mockRejectedValueOnce(new Error('market unavailable'));
  fireEvent.click(screen.getByRole('button', { name: tb().pluginsRefreshMarketplace }));
  await screen.findByText('market unavailable');
  expect(screen.getByText('weather')).toBeVisible();
  expect(screen.getByRole('button', { name: `${tb().pluginsInstall}: weather` })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: tb().pluginsRefreshMarketplace }));
  await waitFor(() => expect(screen.getByRole('button', { name: `${tb().pluginsInstall}: weather` })).toBeEnabled());
});
