// @vitest-environment happy-dom
/**
 * 应用市场 is often the first market surface a user opens, so opening it does
 * the same bootstrap the plugins page does: read what is installed and make
 * sure the built-in market is in the list. It then lists the apps of every
 * market, starts the add flow, and manages the markets the user added.
 */

import type { ReactElement } from 'react';
import { act, fireEvent, render as renderBare, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { open as openFolderDialog } from '@tauri-apps/plugin-dialog';
import { Button } from '@/components/ds/button';
import { DesignSystemProvider } from '@/components/ds/provider';
import { TOAST_SETTLE_MS } from '@/components/ds/styles';
import { keepClosingLayersOnScreen } from '@/test/dsWindows';

vi.mock('@/core/plugin/installedStore', () => ({
  readInstalled: vi.fn().mockResolvedValue([]),
  readInstalledResult: vi.fn().mockResolvedValue({ ok: true, plugins: [] }),
  upsertInstalled: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/core/permissions/pluginToolPolicy', () => ({ setPluginServerNames: vi.fn() }));
vi.mock('@/core/plugin/builtinMarket', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/plugin/builtinMarket')>()),
  resolveBuiltinMarketDir: vi.fn(),
}));
vi.mock('@/core/plugin/marketSource', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/plugin/marketSource')>()),
  refreshFetchedMarkets: vi.fn().mockResolvedValue(undefined),
  removeMarket: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/core/app/appMarket', () => ({ loadAppListings: vi.fn() }));
// The confirmation has its own suite; here only that the market holds one matters.
vi.mock('./AppAddConfirmDialog', () => ({
  default: ({ within: place }: { within: string }) => <div data-testid="stub-add-confirm" data-within={place} />,
}));

import { resolveBuiltinMarketDir } from '@/core/plugin/builtinMarket';
import { refreshFetchedMarkets, removeMarket } from '@/core/plugin/marketSource';
import { loadAppListings, type AppListing, type AppMarketListing } from '@/core/app/appMarket';
import { getI18n, format } from '@/i18n';
import { DEFAULT_APP_CONFIG } from '@/data/defaultAppConfig';
import { useAppStore } from '@/stores/appStore';
import { useAppAddFlowStore } from '@/stores/appAddFlowStore';
import { usePluginStore, type MarketplaceRef } from '@/stores/pluginStore';
import AppMarketDialog from './AppMarketDialog';

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });
const copy = () => getI18n().appMarket;
const refreshInstalled = vi.fn().mockResolvedValue(undefined);
const ensureBuiltinMarketplace = vi.fn();
const startAdd = vi.fn().mockResolvedValue(undefined);
const open = () => act(() => { useAppStore.getState().setAppMarketOpen(true); });
const flush = () => act(async () => { await Promise.resolve(); });

const official: MarketplaceRef = { name: 'abu-official', dir: '/bundle/abu-market', builtin: true };
const acme: MarketplaceRef = { name: 'acme', dir: '/Users/testuser/.abu/markets/acme' };
const item = (market: MarketplaceRef, name: string, more: Partial<AppListing> = {}): AppListing => ({
  market,
  entry: { name, source: { kind: 'relative', path: `./apps/${name}` }, version: '1.0.0' },
  appId: `${name}@${market.name}`,
  name,
  version: '1.0.0',
  uses: [],
  needsUpgrade: false,
  ...more,
});
const recruiting = item(official, 'recruiting', { name: '招聘', description: '筛简历、约面试', uses: ['招聘专家团'] });
const contracts = item(acme, 'contracts', { name: '合同审阅', version: '2.0.0', entry: { name: 'contracts', source: { kind: 'relative', path: './apps/contracts' }, version: '2.0.0' } });
const future = item(acme, 'future', { name: '明年的应用', needsUpgrade: true });
const broken = item(acme, 'broken', { name: '写坏的应用', invalid: 'home.modes is missing' });
const listing = (listings: AppListing[], failures: AppMarketListing['failures'] = []): AppMarketListing => ({ listings, failures });
const entry = (target: AppListing) => document.querySelector<HTMLElement>(`[data-testid="app-market-entry"][data-app-id="${target.appId}"]`)!;

async function shown(listings: AppListing[] = [recruiting, contracts, future, broken]) {
  vi.mocked(loadAppListings).mockResolvedValue(listing(listings));
  render(<AppMarketDialog />);
  open();
  await screen.findByTestId('app-market-list');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveBuiltinMarketDir).mockResolvedValue('/bundle/abu-market');
  vi.mocked(loadAppListings).mockResolvedValue(listing([]));
  usePluginStore.setState({ refreshInstalled, ensureBuiltinMarketplace, marketplaces: [acme, official], installed: [] });
  useAppStore.setState({ appMarketOpen: false, addedApps: [], managedApps: {}, selectedAppId: '__general__' });
  useAppAddFlowStore.setState({ flow: { kind: 'closed' }, running: false, start: startAdd });
});
afterEach(() => {
  usePluginStore.setState({ marketplaces: [] });
  useAppStore.setState({ appMarketOpen: false, addedApps: [] });
});

describe('AppMarketDialog', () => {
  it('renders nothing and reads nothing while it is closed', async () => {
    render(<AppMarketDialog />);
    await act(async () => {});
    expect(screen.queryByTestId('app-market-dialog')).toBeNull();
    expect(refreshInstalled).not.toHaveBeenCalled();
    expect(ensureBuiltinMarketplace).not.toHaveBeenCalled();
    expect(loadAppListings).not.toHaveBeenCalled();
  });

  it('on opening, reads what is installed, fetches the markets added by address again and makes sure the built-in market is listed', async () => {
    render(<AppMarketDialog />);
    open();

    await waitFor(() => expect(refreshInstalled).toHaveBeenCalledExactlyOnceWith('/Users/testuser'));
    await waitFor(() => expect(refreshFetchedMarkets).toHaveBeenCalledExactlyOnceWith('/Users/testuser'));
    await waitFor(() => expect(ensureBuiltinMarketplace).toHaveBeenCalledExactlyOnceWith('/bundle/abu-market'));
    // The official market is read first, whatever its place in the list.
    await waitFor(() => expect(loadAppListings).toHaveBeenCalled());
    expect(vi.mocked(loadAppListings).mock.calls[0][0].map((market) => market.name)).toEqual(['abu-official', 'acme']);
  });

  it('adds no built-in market when the bundle has none', async () => {
    vi.mocked(resolveBuiltinMarketDir).mockResolvedValue(null);
    render(<AppMarketDialog />);
    open();
    await waitFor(() => expect(refreshInstalled).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(ensureBuiltinMarketplace).not.toHaveBeenCalled();
  });

  it('is a window named 应用市场, with its title, what it is for and a search field', async () => {
    await shown();
    const dialog = screen.getByTestId('app-market-dialog');
    expect(dialog).toBe(screen.getByRole('dialog'));
    expect(dialog).toHaveAccessibleName(copy().title);
    expect(dialog).toHaveTextContent(copy().subtitle);
    const search = screen.getByTestId('app-market-search');
    expect(search).toHaveAccessibleName(copy().searchPlaceholder);
    expect(search).toHaveAttribute('placeholder', copy().searchPlaceholder);
  });

  it('gives its content a fixed height and holds the confirmation of an add started here', async () => {
    await shown();
    expect(screen.getByTestId('app-market-list').closest('.h-120')).not.toBeNull();
    expect(screen.getByTestId('stub-add-confirm')).toHaveAttribute('data-within', 'market');
    expect(screen.getByTestId('app-market-dialog')).toContainElement(screen.getByTestId('app-market-list'));
  });

  it('shows one spinner while the markets are read, and says so when there is no app', async () => {
    let finish!: (value: AppMarketListing) => void;
    vi.mocked(loadAppListings).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<AppMarketDialog />);
    open();
    await waitFor(() => expect(loadAppListings).toHaveBeenCalled());
    expect(screen.getByRole('status')).toHaveTextContent(getI18n().common.loading);

    await act(async () => { finish(listing([])); });
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByTestId('app-market-empty')).toHaveTextContent(copy().emptyTitle);
    expect(screen.getByTestId('app-market-empty')).toHaveTextContent(copy().emptyHint);
  });

  it('lists every app with what it uses: 使用 for one not added, 进入 and 更新 for one that is', async () => {
    useAppStore.setState({ addedApps: [{ appId: contracts.appId, name: '合同审阅', config: DEFAULT_APP_CONFIG, version: '1.0.0', origin: { kind: 'market', market: 'acme' }, plugins: [] }] });
    await shown();

    expect(screen.getAllByTestId('app-market-entry')).toHaveLength(4);
    expect(screen.getByTestId('app-market-dialog')).toHaveTextContent(format(copy().entryCount, { count: 4 }));
    expect(entry(recruiting)).toHaveTextContent('招聘');
    expect(entry(recruiting)).toHaveTextContent(format(copy().uses, { names: '招聘专家团' }));
    expect(within(entry(recruiting)).getByTestId('app-market-use')).toBeEnabled();
    // Added at 1.0.0 while the market holds 2.0.0.
    expect(within(entry(contracts)).getByTestId('app-market-update')).toHaveTextContent(copy().update);
    expect(within(entry(contracts)).getByTestId('app-market-enter')).toHaveTextContent(copy().enter);
    expect(within(entry(contracts)).queryByTestId('app-market-use')).toBeNull();
  });

  it('offers no 更新 for an app added at the version the market holds', async () => {
    useAppStore.setState({ addedApps: [{ appId: contracts.appId, name: '合同审阅', config: DEFAULT_APP_CONFIG, version: '2.0.0', origin: { kind: 'market', market: 'acme' }, plugins: [] }] });
    await shown();
    expect(within(entry(contracts)).queryByTestId('app-market-update')).toBeNull();
    expect(within(entry(contracts)).getByTestId('app-market-enter')).toBeInTheDocument();
  });

  it('says an app needs a newer Abu, or is written wrongly, and offers no 使用 for it', async () => {
    await shown();
    expect(within(entry(future)).getByTestId('app-market-needs-upgrade')).toHaveTextContent(copy().needsUpgrade);
    expect(within(entry(future)).getByTestId('app-market-use')).toBeDisabled();
    expect(entry(broken)).toHaveTextContent(copy().invalidApp);
    expect(within(entry(broken)).getByText(copy().invalidApp)).toHaveAttribute('title', 'home.modes is missing');
    expect(within(entry(broken)).getByTestId('app-market-use')).toBeDisabled();
  });

  it('announces a market that cannot be read, by name, with the reason', async () => {
    vi.mocked(loadAppListings).mockResolvedValue(listing([recruiting], [{ market: acme, message: 'No marketplace manifest' }]));
    render(<AppMarketDialog />);
    open();
    expect(await screen.findByRole('alert')).toHaveTextContent('acme: No marketplace manifest');
  });

  it('filters by what is typed in the search field, and starts with an empty search every time it opens', async () => {
    await shown();
    fireEvent.change(screen.getByTestId('app-market-search'), { target: { value: '招聘专家团' } });
    expect(screen.getAllByTestId('app-market-entry')).toHaveLength(1);
    expect(screen.getByTestId('app-market-dialog')).toHaveTextContent(format(copy().entryCount, { count: 1 }));

    act(() => { useAppStore.getState().setAppMarketOpen(false); });
    open();
    expect((screen.getByTestId('app-market-search') as HTMLInputElement).value).toBe('');
  });

  it('使用 and 更新 start the add flow for that app, and the window stays', async () => {
    useAppStore.setState({ addedApps: [{ appId: contracts.appId, name: '合同审阅', config: DEFAULT_APP_CONFIG, version: '1.0.0', origin: { kind: 'market', market: 'acme' }, plugins: [] }] });
    await shown();
    fireEvent.click(within(entry(recruiting)).getByTestId('app-market-use'));
    expect(startAdd).toHaveBeenCalledExactlyOnceWith({ kind: 'market', market: official, entry: recruiting.entry }, '招聘', 'add');
    fireEvent.click(within(entry(contracts)).getByTestId('app-market-update'));
    expect(startAdd).toHaveBeenLastCalledWith({ kind: 'market', market: acme, entry: contracts.entry }, '合同审阅', 'update');
    expect(useAppStore.getState().appMarketOpen).toBe(true);
  });

  it('进入 enters the app, which closes the window', async () => {
    const added = { appId: contracts.appId, name: '合同审阅', config: DEFAULT_APP_CONFIG, version: '2.0.0', origin: { kind: 'market' as const, market: 'acme' }, plugins: [] };
    useAppStore.setState({ addedApps: [added] });
    await shown();
    fireEvent.click(within(entry(contracts)).getByTestId('app-market-enter'));
    expect(useAppStore.getState().selectedAppId).toBe(contracts.appId);
    expect(useAppStore.getState().appMarketOpen).toBe(false);
  });

  it('从文件夹添加 previews the folder the user picks, and does nothing when none is picked', async () => {
    await shown();
    vi.mocked(openFolderDialog).mockResolvedValueOnce(null);
    fireEvent.click(screen.getByTestId('app-market-from-folder'));
    await flush();
    expect(startAdd).not.toHaveBeenCalled();

    vi.mocked(openFolderDialog).mockResolvedValueOnce('/Users/testuser/dev/weekly-report');
    fireEvent.click(screen.getByTestId('app-market-from-folder'));
    await flush();
    expect(startAdd).toHaveBeenCalledExactlyOnceWith({ kind: 'folder', dir: '/Users/testuser/dev/weekly-report' }, 'weekly-report', 'preview');
  });

  it('reads the list again once an add flow has ended', async () => {
    await shown();
    const before = vi.mocked(loadAppListings).mock.calls.length;
    act(() => { useAppAddFlowStore.setState({ flow: { kind: 'planning', name: '招聘' } }); });
    await flush();
    expect(vi.mocked(loadAppListings).mock.calls.length).toBe(before);
    act(() => { useAppAddFlowStore.setState({ flow: { kind: 'closed' } }); });
    await waitFor(() => expect(vi.mocked(loadAppListings).mock.calls.length).toBe(before + 1));
  });

  describe('the markets the user added', () => {
    const removeButton = (name = 'acme') => screen.getByRole('button', { name: `${copy().removeMarket}: ${name}` });
    const question = () => screen.queryByRole('alertdialog');
    const confirmButton = () => within(question()!).getByRole('button', { name: copy().removeMarket });

    it('lists them, each with 移除, and never the built-in one', async () => {
      await shown();
      const markets = screen.getAllByTestId('app-market-market');
      expect(markets.map((market) => market.textContent)).toEqual(['acme']);
      expect(removeButton()).toHaveAttribute('data-testid', 'app-market-remove-market-acme');
      expect(screen.queryByRole('button', { name: `${copy().removeMarket}: abu-official` })).toBeNull();
    });

    it('shows no list when only the built-in market is there', async () => {
      usePluginStore.setState({ marketplaces: [official] });
      await shown();
      expect(screen.queryByTestId('app-market-markets')).toBeNull();
    });

    it('asks before removing one, by name, and keeps it when the answer is cancel or Escape', async () => {
      await shown();
      fireEvent.click(removeButton());
      await flush();
      expect(question()).toHaveAccessibleName(format(copy().removeMarketTitle, { name: 'acme' }));
      expect(question()).toHaveTextContent(copy().removeMarketMessage);
      // The question stacks over the market, which stays.
      expect(screen.getByTestId('app-market-dialog')).toBeInTheDocument();

      fireEvent.click(within(question()!).getByRole('button', { name: getI18n().common.cancel }));
      await flush();
      expect(removeMarket).not.toHaveBeenCalled();

      fireEvent.click(removeButton());
      await flush();
      fireEvent.keyDown(within(question()!).getByRole('button', { name: getI18n().common.cancel }), { key: 'Escape', code: 'Escape' });
      await flush();
      expect(removeMarket).not.toHaveBeenCalled();
      expect(useAppStore.getState().appMarketOpen).toBe(true);
    });

    it('removes the market that was asked about, once, with the home directory', async () => {
      await shown();
      fireEvent.click(removeButton());
      await flush();
      act(() => {
        fireEvent.click(confirmButton());
        fireEvent.click(confirmButton());
      });
      await flush();
      expect(removeMarket).toHaveBeenCalledExactlyOnceWith('acme', '/Users/testuser');
    });

    it('removes nothing when the market has gone from the list by the time of the answer', async () => {
      await shown();
      fireEvent.click(removeButton());
      await flush();
      act(() => { usePluginStore.setState({ marketplaces: [official] }); });
      fireEvent.click(confirmButton());
      await flush();
      expect(removeMarket).not.toHaveBeenCalled();
    });

    it('after a market is removed the focus goes to 添加市场', async () => {
      vi.mocked(removeMarket).mockImplementation(async () => { usePluginStore.setState({ marketplaces: [official] }); });
      await shown();
      removeButton().focus();
      fireEvent.click(removeButton());
      await flush();
      fireEvent.click(confirmButton());
      await flush();
      await waitFor(() => expect(screen.getByTestId('app-market-add-market')).toHaveFocus());
    });

    describe('a press on the question', () => {
      beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
      afterEach(() => { vi.useRealTimers(); });

      it('takes no pointer press before the question has settled, and one press after it removes', async () => {
        await shown();
        fireEvent.click(removeButton());
        await flush();
        fireEvent.pointerDown(confirmButton());
        fireEvent.click(confirmButton(), { detail: 1 });
        await flush();
        expect(removeMarket).not.toHaveBeenCalled();
        expect(question()).not.toBeNull();

        act(() => { vi.advanceTimersByTime(TOAST_SETTLE_MS); });
        fireEvent.pointerDown(confirmButton());
        fireEvent.click(confirmButton(), { detail: 1 });
        await flush();
        expect(removeMarket).toHaveBeenCalledExactlyOnceWith('acme', '/Users/testuser');
      });

      it('is not answered by the repeats of an Enter held since the 移除 button', async () => {
        await shown();
        removeButton().focus();
        fireEvent.keyDown(removeButton(), { key: 'Enter', code: 'Enter' });
        fireEvent.click(removeButton());
        await flush();
        for (let i = 0; i < 5; i += 1) {
          // fireEvent returns false once the default was prevented: the browser makes no click.
          expect(fireEvent.keyDown(confirmButton(), { key: 'Enter', code: 'Enter', repeat: true })).toBe(false);
        }
        await flush();
        expect(question()).not.toBeNull();
        expect(removeMarket).not.toHaveBeenCalled();
      });
    });
  });

  describe('添加市场', () => {
    it('waits for the home directory, then opens its window inside the market, which stays', async () => {
      await shown();
      const add = screen.getByTestId('app-market-add-market');
      expect(add).toBeEnabled();
      fireEvent.click(add);
      const addWindow = await screen.findByTestId('plugin-add-marketplace');
      expect(addWindow).toHaveAccessibleName(getI18n().toolbox.pluginsAddMarketplaceTitle);
      expect(useAppStore.getState().appMarketOpen).toBe(true);
      expect(screen.getByTestId('app-market-list')).toBeInTheDocument();

      // Escape closes the window on top alone.
      fireEvent.keyDown(screen.getByTestId('plugin-marketplace-dir-input'), { key: 'Escape', code: 'Escape' });
      await waitFor(() => expect(screen.queryByTestId('plugin-add-marketplace')).toBeNull());
      expect(useAppStore.getState().appMarketOpen).toBe(true);
    });
  });

  describe('closing', () => {
    it('gives the focus to the app switcher\'s button when it closes with nothing else to return to', async () => {
      vi.mocked(loadAppListings).mockResolvedValue(listing([recruiting]));
      renderBare(
        <DesignSystemProvider>
          <Button data-testid="app-switcher-trigger">Switcher</Button>
          <AppMarketDialog />
        </DesignSystemProvider>,
      );
      // Opened from a control that has gone: by then no control has the focus.
      open();
      await screen.findByTestId('app-market-list');
      fireEvent.keyDown(screen.getByTestId('app-market-search'), { key: 'Escape' });

      await waitFor(() => expect(screen.getByTestId('app-switcher-trigger')).toHaveFocus());
    });

    it('gives the focus back to the button that opened it when that button is still there', async () => {
      vi.mocked(loadAppListings).mockResolvedValue(listing([recruiting]));
      renderBare(
        <DesignSystemProvider>
          <Button data-testid="app-switcher-trigger">Switcher</Button>
          <Button onClick={() => useAppStore.getState().setAppMarketOpen(true)}>Find another app</Button>
          <AppMarketDialog />
        </DesignSystemProvider>,
      );
      const opener = screen.getByRole('button', { name: 'Find another app' });
      opener.focus();
      fireEvent.click(opener);
      await screen.findByTestId('app-market-list');
      fireEvent.keyDown(screen.getByTestId('app-market-search'), { key: 'Escape' });

      await waitFor(() => expect(opener).toHaveFocus());
    });

    it('closes from its close button and from Escape', async () => {
      await shown();
      fireEvent.click(screen.getByRole('button', { name: getI18n().common.close }));
      expect(useAppStore.getState().appMarketOpen).toBe(false);

      open();
      fireEvent.keyDown(screen.getByTestId('app-market-search'), { key: 'Escape' });
      expect(useAppStore.getState().appMarketOpen).toBe(false);
    });

    it('keeps showing its list while it fades out, and starts nothing from a press there', async () => {
      const computedStyle = keepClosingLayersOnScreen();
      try {
        useAppStore.setState({ addedApps: [{ appId: contracts.appId, name: '合同审阅', config: DEFAULT_APP_CONFIG, version: '1.0.0', origin: { kind: 'market', market: 'acme' }, plugins: [] }] });
        await shown();
        act(() => { useAppStore.getState().setAppMarketOpen(false); });
        expect(document.querySelector('[role="dialog"][data-state="closed"]')).not.toBeNull();
        expect(screen.getAllByTestId('app-market-entry')).toHaveLength(4);

        fireEvent.click(within(entry(recruiting)).getByTestId('app-market-use'));
        fireEvent.click(within(entry(contracts)).getByTestId('app-market-update'));
        fireEvent.click(within(entry(contracts)).getByTestId('app-market-enter'));
        fireEvent.click(screen.getByTestId('app-market-from-folder'));
        fireEvent.click(screen.getByTestId('app-market-add-market'));
        fireEvent.click(screen.getByTestId('app-market-remove-market-acme'));
        await flush();

        expect(startAdd).not.toHaveBeenCalled();
        expect(openFolderDialog).not.toHaveBeenCalled();
        expect(useAppStore.getState().selectedAppId).toBe('__general__');
        expect(screen.queryByTestId('plugin-add-marketplace')).toBeNull();
        expect(screen.queryByRole('alertdialog')).toBeNull();
        expect(removeMarket).not.toHaveBeenCalled();
      } finally {
        computedStyle.mockRestore();
      }
    });
  });
});
