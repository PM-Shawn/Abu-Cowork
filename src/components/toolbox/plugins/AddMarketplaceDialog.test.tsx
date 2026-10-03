// @vitest-environment happy-dom
/**
 * Adding a marketplace stores a pointer the install flow later trusts, so the
 * directory is parsed before it is stored and the marketplace's own declared
 * name is what gets stored. These tests pin the calls, their arguments and
 * their order, and that a busy window neither submits twice nor closes.
 */

import { useState, type ReactElement } from 'react';
import { act, fireEvent, render as renderBare, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ds/button';
import { DesignSystemProvider } from '@/components/ds/provider';

vi.mock('@/core/plugin/loadMarketplace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/plugin/loadMarketplace')>()),
  loadMarketplaceFromDir: vi.fn(),
}));
vi.mock('@/utils/electronHost', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/electronHost')>()),
  canonicalizeElectronPathForPolicy: vi.fn(),
}));
vi.mock('@/core/plugin/installedStore', () => ({
  readInstalled: vi.fn().mockResolvedValue([]),
  readInstalledResult: vi.fn().mockResolvedValue({ ok: true, plugins: [] }),
  upsertInstalled: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/core/permissions/pluginToolPolicy', () => ({ setPluginServerNames: vi.fn() }));

import { open as pickDirectory } from '@tauri-apps/plugin-dialog';
import { getI18n } from '@/i18n';
import type { Marketplace } from '@/core/plugin/marketplace';
import { loadMarketplaceFromDir } from '@/core/plugin/loadMarketplace';
import { usePluginStore } from '@/stores/pluginStore';
import { canonicalizeElectronPathForPolicy } from '@/utils/electronHost';
import AddMarketplaceDialog from './AddMarketplaceDialog';

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });
const tb = () => getI18n().toolbox;
const HOME = '/Users/tester';
const demo: Marketplace = { name: 'demo-market', plugins: [] };

const calls: string[] = [];
const addMarketplace = vi.fn((name: string, dir: string) => { calls.push(`addMarketplace:${name}:${dir}`); });
const onAdded = vi.fn((name: string) => { calls.push(`onAdded:${name}`); });
const onClose = vi.fn(() => { calls.push('onClose'); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const input = () => screen.getByTestId('plugin-marketplace-dir-input') as HTMLInputElement;
const submit = () => screen.getByTestId('plugin-marketplace-submit');
const type = (value: string) => fireEvent.change(input(), { target: { value } });

function open() {
  return render(<AddMarketplaceDialog open home={HOME} onClose={onClose} onAdded={onAdded} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  usePluginStore.setState({ marketplaces: [], addMarketplace });
  // The host resolves links: what is stored is the resolved directory.
  vi.mocked(canonicalizeElectronPathForPolicy).mockImplementation(async (path) => `/real${path}`);
  vi.mocked(loadMarketplaceFromDir).mockImplementation(async (dir) => { calls.push(`load:${dir}`); return demo; });
});

describe('AddMarketplaceDialog', () => {
  it('reads the resolved directory, stores the declared name with it, reports it and closes, in that order', async () => {
    open();
    type('  ~/markets/demo  ');
    fireEvent.click(submit());

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(canonicalizeElectronPathForPolicy).toHaveBeenCalledWith(`${HOME}/markets/demo`);
    expect(calls).toEqual([
      `load:/real${HOME}/markets/demo`,
      `addMarketplace:demo-market:/real${HOME}/markets/demo`,
      'onAdded:demo-market',
      'onClose',
    ]);
  });

  it('stores the typed directory when the host cannot resolve it', async () => {
    vi.mocked(canonicalizeElectronPathForPolicy).mockResolvedValue(null);
    open();
    type('/markets/demo');
    fireEvent.click(submit());

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(calls).toEqual(['load:/markets/demo', 'addMarketplace:demo-market:/markets/demo', 'onAdded:demo-market', 'onClose']);
  });

  it('submits with Enter in the directory field', async () => {
    open();
    type('/markets/demo');
    fireEvent.keyDown(input(), { key: 'Enter' });

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(addMarketplace).toHaveBeenCalledExactlyOnceWith('demo-market', '/real/markets/demo');
  });

  it('only selects a marketplace that is already stored under the same name and directory', async () => {
    usePluginStore.setState({ marketplaces: [{ name: 'demo-market', dir: '/markets/demo' }] });
    open();
    type('/markets/demo');
    fireEvent.click(submit());

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(addMarketplace).not.toHaveBeenCalled();
    expect(calls).toEqual(['load:/real/markets/demo', 'onAdded:demo-market', 'onClose']);
  });

  it('stores the directory again when the same name now points somewhere else', async () => {
    usePluginStore.setState({ marketplaces: [{ name: 'demo-market', dir: '/markets/old' }] });
    open();
    type('/markets/demo');
    fireEvent.click(submit());

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(addMarketplace).toHaveBeenCalledExactlyOnceWith('demo-market', '/real/markets/demo');
  });

  it('shows why the directory could not be read, stays open and keeps what was typed', async () => {
    vi.mocked(loadMarketplaceFromDir).mockRejectedValue(new Error('No marketplace manifest in /real/markets/demo'));
    open();
    type('/markets/demo');
    fireEvent.click(submit());

    expect(await screen.findByText('No marketplace manifest in /real/markets/demo')).toBeInTheDocument();
    expect(screen.getByText(tb().pluginsMarketplaceReadFailed)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(onAdded).not.toHaveBeenCalled();
    expect(addMarketplace).not.toHaveBeenCalled();
    expect(input().value).toBe('/markets/demo');
    // The window can be used again: a second attempt reads the directory once more.
    vi.mocked(loadMarketplaceFromDir).mockResolvedValue(demo);
    fireEvent.click(submit());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(loadMarketplaceFromDir).toHaveBeenCalledTimes(2);
  });

  it('does nothing while the directory is empty or only spaces', () => {
    open();
    expect(submit()).toBeDisabled();
    type('   ');
    expect(submit()).toBeDisabled();
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(canonicalizeElectronPathForPolicy).not.toHaveBeenCalled();
    expect(loadMarketplaceFromDir).not.toHaveBeenCalled();
  });

  it('reads the directory once when submit is pressed again while the first read is running', async () => {
    const reading = deferred<Marketplace>();
    vi.mocked(loadMarketplaceFromDir).mockReturnValue(reading.promise);
    open();
    type('/markets/demo');
    fireEvent.click(submit());
    await waitFor(() => expect(loadMarketplaceFromDir).toHaveBeenCalledTimes(1));

    fireEvent.click(submit());
    fireEvent.keyDown(input(), { key: 'Enter' });
    await act(async () => { reading.resolve(demo); });

    expect(canonicalizeElectronPathForPolicy).toHaveBeenCalledTimes(1);
    expect(loadMarketplaceFromDir).toHaveBeenCalledTimes(1);
    expect(addMarketplace).toHaveBeenCalledTimes(1);
    expect(onAdded).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays open on Escape while the directory is being read, with Cancel unavailable', async () => {
    const reading = deferred<Marketplace>();
    vi.mocked(loadMarketplaceFromDir).mockReturnValue(reading.promise);
    open();
    type('/markets/demo');
    fireEvent.click(submit());
    await waitFor(() => expect(loadMarketplaceFromDir).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(screen.getByRole('button', { name: getI18n().common.cancel })).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('plugin-add-marketplace')).toBeInTheDocument();

    await act(async () => { reading.reject(new Error('unreadable')); });
    await screen.findByText('unreadable');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('puts the picked folder into the field and reads nothing until submit', async () => {
    vi.mocked(pickDirectory).mockResolvedValue('/picked/market');
    open();
    fireEvent.click(screen.getByRole('button', { name: tb().pluginsBrowseDir }));

    await waitFor(() => expect(input().value).toBe('/picked/market'));
    expect(pickDirectory).toHaveBeenCalledExactlyOnceWith({ directory: true, multiple: false });
    expect(loadMarketplaceFromDir).not.toHaveBeenCalled();
  });

  it('opens empty after it was closed with a directory typed and an error shown', async () => {
    vi.mocked(loadMarketplaceFromDir).mockRejectedValue(new Error('unreadable'));
    function Owner() {
      const [shown, setShown] = useState(true);
      return (
        <>
          <Button onClick={() => setShown(false)}>Hide</Button>
          <Button onClick={() => setShown(true)}>Show</Button>
          <AddMarketplaceDialog open={shown} home={HOME} onClose={onClose} />
        </>
      );
    }
    render(<Owner />);
    type('/markets/demo');
    fireEvent.click(submit());
    await screen.findByText('unreadable');

    fireEvent.click(screen.getByText('Hide'));
    fireEvent.click(screen.getByText('Show'));

    expect(input().value).toBe('');
    expect(screen.queryByText('unreadable')).toBeNull();
  });

  it('is a named window whose failure is announced', async () => {
    vi.mocked(loadMarketplaceFromDir).mockRejectedValue(new Error('unreadable'));
    open();
    expect(screen.getByRole('dialog')).toHaveAccessibleName(tb().pluginsAddMarketplaceTitle);
    expect(screen.getByLabelText(tb().pluginsMarketplaceDirLabel)).toBe(input());
    type('/markets/demo');
    fireEvent.click(submit());

    expect(await screen.findByRole('alert')).toHaveTextContent('unreadable');
  });

  it('keeps the focus on the pressed control while the directory is being read', async () => {
    const reading = deferred<Marketplace>();
    vi.mocked(loadMarketplaceFromDir).mockReturnValue(reading.promise);
    open();
    type('/markets/demo');
    fireEvent.click(submit());
    await waitFor(() => expect(loadMarketplaceFromDir).toHaveBeenCalledTimes(1));

    // Working, not disabled: a disabled control would drop the keyboard focus onto the window.
    expect(submit()).toHaveAttribute('aria-disabled', 'true');
    expect(submit()).not.toBeDisabled();
    expect(input()).not.toBeDisabled();
    expect(input()).toHaveAttribute('readonly');
    await act(async () => { reading.resolve(demo); });
  });

  it('asks before Escape discards a typed directory, and closes an empty window at once', () => {
    open();
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    type('/markets/demo');
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toHaveTextContent(getI18n().designSystem.discardTitle);

    fireEvent.click(screen.getByRole('button', { name: getI18n().designSystem.discard }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  describe('while the window fades out', () => {
    // happy-dom reports no animation, so Radix removes a closed layer at once. With this, a closed
    // layer has an exit animation: it stays on the page, as it does in the app while it fades out.
    function keepClosingLayersOnScreen() {
      const real = window.getComputedStyle.bind(window);
      return vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) => {
        const styles = real(element, pseudo);
        return new Proxy(styles, {
          get(target, prop) {
            if (prop === 'animationName') return element.getAttribute('data-state') === 'closed' ? 'exit' : 'enter';
            const value = Reflect.get(target, prop);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      });
    }

    it('reads nothing when submit or Enter lands on the closing window', async () => {
      const computedStyle = keepClosingLayersOnScreen();
      const view = open();
      type('/markets/demo');
      view.rerender(<AddMarketplaceDialog open={false} home={HOME} onClose={onClose} onAdded={onAdded} />);
      expect(document.querySelector('[role="dialog"][data-state="closed"]')).not.toBeNull();

      fireEvent.click(submit());
      fireEvent.keyDown(input(), { key: 'Enter' });
      await act(async () => {});

      expect(canonicalizeElectronPathForPolicy).not.toHaveBeenCalled();
      expect(loadMarketplaceFromDir).not.toHaveBeenCalled();
      expect(addMarketplace).not.toHaveBeenCalled();
      computedStyle.mockRestore();
    });
  });
});

afterEach(() => {
  usePluginStore.setState(usePluginStore.getInitialState());
});
