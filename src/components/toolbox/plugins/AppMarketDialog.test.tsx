// @vitest-environment happy-dom
/**
 * 应用市场 is often the first market surface a user opens, so opening it does
 * the same bootstrap the plugins page does: read what is installed and make
 * sure the built-in market is in the list. The listing itself is
 * `MarketplaceBrowser` in its apps mode, which has its own suite.
 */

import type { ReactElement } from 'react';
import { act, fireEvent, render as renderBare, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ds/button';
import { DesignSystemProvider } from '@/components/ds/provider';

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
// The listing has its own suite; here only what the window hands it matters.
vi.mock('./MarketplaceBrowser', async () => {
  const { Button } = await import('@/components/ds/button');
  return {
    default: (props: { home: string; mode?: string; searchQuery: string; onAddMarketplace: () => void }) => (
      <div data-testid="stub-browser" data-home={props.home} data-mode={props.mode} data-query={props.searchQuery}>
        <Button onClick={props.onAddMarketplace}>stub-add</Button>
      </div>
    ),
  };
});

import { resolveBuiltinMarketDir } from '@/core/plugin/builtinMarket';
import { getI18n } from '@/i18n';
import { useAppStore } from '@/stores/appStore';
import { usePluginStore } from '@/stores/pluginStore';
import AppMarketDialog from './AppMarketDialog';

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });
const copy = () => getI18n().appMarket;
const refreshInstalled = vi.fn().mockResolvedValue(undefined);
const ensureBuiltinMarketplace = vi.fn();
const open = () => act(() => { useAppStore.getState().setAppMarketOpen(true); });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveBuiltinMarketDir).mockResolvedValue('/bundle/abu-market');
  usePluginStore.setState({ refreshInstalled, ensureBuiltinMarketplace });
  useAppStore.setState({ appMarketOpen: false });
});

describe('AppMarketDialog', () => {
  it('renders nothing and reads nothing while it is closed', async () => {
    render(<AppMarketDialog />);
    await act(async () => {});
    expect(screen.queryByTestId('app-market-dialog')).toBeNull();
    expect(refreshInstalled).not.toHaveBeenCalled();
    expect(ensureBuiltinMarketplace).not.toHaveBeenCalled();
  });

  it('on opening, reads what is installed for the home directory and makes sure the built-in market is listed', async () => {
    render(<AppMarketDialog />);
    open();

    await waitFor(() => expect(refreshInstalled).toHaveBeenCalledExactlyOnceWith('/Users/testuser'));
    await waitFor(() => expect(ensureBuiltinMarketplace).toHaveBeenCalledExactlyOnceWith('/bundle/abu-market'));
    const browser = await screen.findByTestId('stub-browser');
    expect(browser).toHaveAttribute('data-home', '/Users/testuser');
    expect(browser).toHaveAttribute('data-mode', 'apps');
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
    render(<AppMarketDialog />);
    open();
    const dialog = screen.getByTestId('app-market-dialog');
    expect(dialog).toBe(screen.getByRole('dialog'));
    expect(dialog).toHaveAccessibleName(copy().title);
    expect(dialog).toHaveTextContent(copy().subtitle);
    const search = screen.getByTestId('app-market-search');
    expect(search).toHaveAccessibleName(copy().searchPlaceholder);
    expect(search).toHaveAttribute('placeholder', copy().searchPlaceholder);
    await screen.findByTestId('stub-browser');
  });

  it('hands what is typed in the search field to the listing', async () => {
    render(<AppMarketDialog />);
    open();
    const browser = await screen.findByTestId('stub-browser');
    expect(browser).toHaveAttribute('data-query', '');
    fireEvent.change(screen.getByTestId('app-market-search'), { target: { value: 'shop' } });
    expect(browser).toHaveAttribute('data-query', 'shop');
  });

  it('gives the listing a fixed height to render its rows in', async () => {
    render(<AppMarketDialog />);
    open();
    const browser = await screen.findByTestId('stub-browser');
    expect(browser.parentElement).toHaveClass('h-120');
  });

  it('starts with an empty search every time it opens', async () => {
    render(<AppMarketDialog />);
    open();
    await screen.findByTestId('stub-browser');
    fireEvent.change(screen.getByTestId('app-market-search'), { target: { value: 'shop' } });
    act(() => { useAppStore.getState().setAppMarketOpen(false); });
    open();
    expect((screen.getByTestId('app-market-search') as HTMLInputElement).value).toBe('');
  });

  it('gives the focus to the app switcher\'s button when it closes with nothing else to return to', async () => {
    renderBare(
      <DesignSystemProvider>
        <Button data-testid="app-switcher-trigger">Switcher</Button>
        <AppMarketDialog />
      </DesignSystemProvider>,
    );
    // Opened from the switcher's menu: by then no control has the focus.
    open();
    await screen.findByTestId('stub-browser');
    fireEvent.keyDown(screen.getByTestId('app-market-search'), { key: 'Escape' });

    await waitFor(() => expect(screen.getByTestId('app-switcher-trigger')).toHaveFocus());
  });

  it('gives the focus back to the button that opened it when that button is still there', async () => {
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
    await screen.findByTestId('stub-browser');
    fireEvent.keyDown(screen.getByTestId('app-market-search'), { key: 'Escape' });

    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('closes from its close button, from Escape and when the listing sends the user to add a market', async () => {
    render(<AppMarketDialog />);
    open();
    await screen.findByTestId('stub-browser');
    fireEvent.click(screen.getByRole('button', { name: getI18n().common.close }));
    expect(useAppStore.getState().appMarketOpen).toBe(false);

    open();
    fireEvent.keyDown(screen.getByTestId('app-market-search'), { key: 'Escape' });
    expect(useAppStore.getState().appMarketOpen).toBe(false);

    open();
    fireEvent.click(screen.getByRole('button', { name: 'stub-add' }));
    expect(useAppStore.getState().appMarketOpen).toBe(false);
  });
});
