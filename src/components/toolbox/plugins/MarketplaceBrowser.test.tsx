// @vitest-environment happy-dom
/**
 * The invariant under test: browsing a marketplace can *plan* an install, but
 * nothing reaches the filesystem until the user confirms the disclosure. A
 * regression here would mean third-party executables land on disk from a
 * single click, with the disclosure reduced to decoration.
 */

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

/** A promise whose resolution this test controls, to drive plan ordering. */
function makeDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

vi.mock('./loadMarketplace', () => ({ loadMarketplaceFromDir: vi.fn() }));
vi.mock('@/core/plugin/installer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/plugin/installer')>()),
  planInstall: vi.fn(),
  installPlugin: vi.fn(),
}));
vi.mock('@/core/plugin/installedStore', () => ({
  readInstalled: vi.fn().mockResolvedValue([]),
  upsertInstalled: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/core/plugin/skillRoots', () => ({ pluginMcpServerNames: vi.fn().mockResolvedValue([]) }));
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
  UnsupportedSourceError,
  type InstallDisclosure,
} from '@/core/plugin/installer';
import { PluginSymlinkRootError } from '@/core/plugin/fsOps';
import { format, getI18n } from '@/i18n';
import type { Marketplace, MarketplaceEntry } from '@/core/plugin/marketplace';
import { usePluginStore } from '@/stores/pluginStore';
import { loadMarketplaceFromDir } from './loadMarketplace';
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
  key: 'weather@official',
  name: 'weather',
  marketplace: 'official',
  version: '1.0.0',
  manifest: { name: 'weather', version: '1.0.0' } as InstallDisclosure['manifest'],
  sourceDir: '/m/official/plugins/weather',
  skills: ['forecast'],
  mcpServers: [{ name: 'weather-mcp', command: 'npx', args: ['-y', '@acme/weather-mcp'] }],
  ignoredPayloads: [],
};

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
    loading: false,
    error: null,
  });
  vi.mocked(loadMarketplaceFromDir).mockResolvedValue(marketplace);
  vi.mocked(planInstall).mockResolvedValue(disclosure);
  // installPlugin now returns { record, mcpServers } (single-plan outcome).
  vi.mocked(installPlugin).mockResolvedValue({
    record: {
      key: `${disclosure.name}@official`,
      marketplace: 'official',
      name: disclosure.name,
      version: disclosure.version ?? '0.0.0',
      installedAt: '2026-09-01T00:00:00.000Z',
      contributed: { skills: disclosure.skills, mcpServers: disclosure.mcpServers.map((s) => s.name) },
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
  });

  it('flags remote-sourced entries before the user clicks Install', async () => {
    renderBrowser();
    await waitFor(() => expect(screen.getAllByTestId('plugin-marketplace-entry')).toHaveLength(2));

    // Only the git-subdir entry is marked — the vendored one installs fine.
    const badges = screen.getAllByTestId('plugin-remote-source-badge');
    expect(badges).toHaveLength(1);
    expect(screen.getAllByTestId('plugin-marketplace-entry')[1]).toContainElement(badges[0]);
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

  it('marks entries already installed from this marketplace as installed', async () => {
    usePluginStore.setState({
      installed: [
        {
          key: 'weather@official',
          marketplace: 'official',
          name: 'weather',
          version: '1.0.0',
          installedAt: '2026-08-31T00:00:00.000Z',
          contributed: { skills: ['forecast'], mcpServers: ['weather-mcp'] },
        },
      ],
    });
    renderBrowser();
    await waitFor(() => expect(screen.getAllByTestId('plugin-marketplace-entry')).toHaveLength(2));

    const rows = screen.getAllByTestId('plugin-marketplace-entry');
    expect(rows[0].querySelector('button')).toBeDisabled();
    expect(rows[1].querySelector('button')).not.toBeDisabled();
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
    expect(list).toHaveAttribute('data-item-count', '300');
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
        installedAt: '2026-09-01T00:00:00.000Z', contributed: { skills: [], mcpServers: [] },
      }],
    });
    renderBrowser();
    await waitFor(() => expect(screen.getAllByTestId('plugin-marketplace-entry').length).toBeGreaterThan(0));
    // weather is installed at 0.9.0, marketplace offers 1.0.0 → updatable.
    expect(screen.getByTestId('plugin-update-button')).toBeInTheDocument();
  });

  it('does not score the previous market\'s entries against a newly selected market', async () => {
    const installedAt = '2026-09-01T00:00:00.000Z';
    const contributed = { skills: [], mcpServers: [] };
    usePluginStore.setState({
      installed: [
        { key: 'weather@official', marketplace: 'official', name: 'weather', version: '0.9.0', installedAt, contributed },
        { key: 'weather@other', marketplace: 'other', name: 'weather', version: '0.9.0', installedAt, contributed },
      ],
      updateAvailableKeys: [],
    });
    renderBrowser();
    await waitFor(() => expect(usePluginStore.getState().updateAvailableKeys).toEqual(['weather@official']));

    // Add a market (auto-selected) whose manifest stays in flight. Without the
    // guard, official's `weather 1.0.0` entry is scored against the
    // `weather@other 0.9.0` install and a bogus `weather@other` key lands.
    const other = makeDeferred<Marketplace>();
    vi.mocked(loadMarketplaceFromDir).mockImplementation((dir) =>
      dir === '/m/other' ? other.promise : Promise.resolve(marketplace),
    );
    await act(async () => {
      usePluginStore.setState({
        marketplaces: [{ name: 'official', dir: '/m/official' }, { name: 'other', dir: '/m/other' }],
      });
    });
    expect(usePluginStore.getState().updateAvailableKeys).toEqual(['weather@official']);

    await act(async () => {
      other.resolve({ name: 'other', plugins: [] });
    });
    await waitFor(() => expect(usePluginStore.getState().updateAvailableKeys).toEqual([]));
  });

  it('shows a disabled Already-installed button when versions match', async () => {
    usePluginStore.setState({
      installed: [{
        key: 'weather@official', marketplace: 'official', name: 'weather', version: '1.0.0',
        installedAt: '2026-09-01T00:00:00.000Z', contributed: { skills: [], mcpServers: [] },
      }],
    });
    renderBrowser();
    await waitFor(() => expect(screen.getAllByTestId('plugin-marketplace-entry').length).toBeGreaterThan(0));
    expect(screen.queryByTestId('plugin-update-button')).toBeNull();
  });
});
