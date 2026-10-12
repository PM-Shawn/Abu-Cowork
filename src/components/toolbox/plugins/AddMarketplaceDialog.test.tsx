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
import { Dialog } from '@/components/ds/dialog';
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

import { invoke } from '@tauri-apps/api/core';
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
const demo: Marketplace = { name: 'demo-market', plugins: [], apps: [] };

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

  it('says a folder could not be read and what to check, stays open and keeps what was typed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(loadMarketplaceFromDir).mockRejectedValue(new Error('No marketplace manifest in /real/markets/demo'));
    open();
    type('/markets/demo');
    fireEvent.click(submit());

    expect(await screen.findByText(tb().pluginsMarketplaceFolderFailed)).toBeInTheDocument();
    expect(screen.getByText(tb().pluginsMarketplaceReadFailed)).toBeInTheDocument();
    // What the reader said goes to the console and nowhere on the page.
    expect(document.body.innerHTML).not.toContain('No marketplace manifest');
    expect(warn).toHaveBeenCalledExactlyOnceWith('[app] add market failed:', 'No marketplace manifest in /real/markets/demo');
    warn.mockRestore();
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
    await screen.findByText(tb().pluginsMarketplaceFolderFailed);
    expect(onClose).not.toHaveBeenCalled();
  });

  describe('an address that cannot be added', () => {
    const fail = async (message: string) => {
      vi.mocked(invoke).mockRejectedValueOnce(new Error(message));
      open();
      type('https://git.example.test/acme/market.git');
      fireEvent.click(submit());
      return screen.findByTestId('plugin-marketplace-error');
    };

    it.each([
      ['[auth_required] 401 from https://git.example.test', () => tb().pluginsMarketplaceAuthRequired],
      ['[not_a_market] no .abu-plugin/marketplace.json in the archive', () => tb().pluginsMarketplaceNotFound],
      ['[name_taken] acme is already added from another address', () => tb().pluginsMarketplaceNameConflict],
    ] as const)('says what the user can do about %s', async (message, sentence) => {
      expect(await fail(message)).toHaveTextContent(sentence());
    });

    it('says the address could not be fetched and what to check when the host gives another reason', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const error = await fail('git clone https://user:hunter2secret@git.example.test/acme/market.git exited with 128');
      expect(error).toHaveTextContent(tb().pluginsMarketplaceAddressFailed);
      expect(document.body.innerHTML).not.toContain('exited with 128');
      expect(document.body.innerHTML).not.toContain('hunter2secret');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toBe('[app] add market failed:');
      expect(String(warn.mock.calls[0][1])).not.toContain('hunter2secret');
      warn.mockRestore();
    });

    it('refuses a second address under a name the list already has, in its own words', async () => {
      usePluginStore.setState({ marketplaces: [{ name: 'demo-market', dir: '/Users/tester/.abu/markets/other' }] });
      vi.mocked(invoke).mockResolvedValueOnce({ name: 'demo-market', dir: '/Users/tester/.abu/markets/demo-market' });
      open();
      type('https://git.example.test/acme/market.git');
      fireEvent.click(submit());
      expect(await screen.findByTestId('plugin-marketplace-error')).toHaveTextContent(tb().pluginsMarketplaceNameConflict);
      expect(addMarketplace).not.toHaveBeenCalled();
    });
  });

  it('says the folder picker could not be opened, in plain words', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(pickDirectory).mockRejectedValueOnce(new Error('dialog.open not allowed by ACL'));
    open();
    fireEvent.click(screen.getByRole('button', { name: tb().pluginsBrowseDir }));
    expect(await screen.findByTestId('plugin-marketplace-error')).toHaveTextContent(tb().pluginsBrowseFailed);
    expect(document.body.innerHTML).not.toContain('ACL');
    expect(warn).toHaveBeenCalledExactlyOnceWith('[app] choose market folder failed:', 'dialog.open not allowed by ACL');
    warn.mockRestore();
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
    await screen.findByText(tb().pluginsMarketplaceFolderFailed);

    fireEvent.click(screen.getByText('Hide'));
    fireEvent.click(screen.getByText('Show'));

    expect(input().value).toBe('');
    expect(screen.queryByText(tb().pluginsMarketplaceFolderFailed)).toBeNull();
  });

  it('is a named window whose failure is announced', async () => {
    vi.mocked(loadMarketplaceFromDir).mockRejectedValue(new Error('unreadable'));
    open();
    expect(screen.getByRole('dialog')).toHaveAccessibleName(tb().pluginsAddMarketplaceTitle);
    expect(screen.getByLabelText(tb().pluginsMarketplaceDirLabel)).toBe(input());
    type('/markets/demo');
    fireEvent.click(submit());

    expect(await screen.findByRole('alert')).toHaveTextContent(tb().pluginsMarketplaceFolderFailed);
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

  // Reading a directory is work in progress: the window steps aside for an approval and comes
  // back. Nothing is cancelled, and it still leaves through its own onClose when the read ends.
  describe('when an approval arrives while the directory is being read', () => {
    const onApprovalAnswer = vi.fn();
    function Owner({ approval }: { approval: boolean }) {
      const [shown, setShown] = useState(true);
      return (
        <>
          <AddMarketplaceDialog open={shown} home={HOME} onClose={() => { onClose(); setShown(false); }} onAdded={onAdded} />
          <Dialog
            open={approval}
            onOpenChange={onApprovalAnswer}
            layer="approval"
            role="alertdialog"
            outsidePress="ignore"
            title="Confirm Action"
            footer={<Button>Cancel the command</Button>}
          />
        </>
      );
    }
    const marketplaceWindow = () => document.querySelector<HTMLElement>('[data-testid="plugin-add-marketplace"]');

    async function startReading() {
      onApprovalAnswer.mockReset();
      const reading = deferred<Marketplace>();
      vi.mocked(loadMarketplaceFromDir).mockReturnValue(reading.promise);
      const view = render(<Owner approval={false} />);
      type('/markets/demo');
      fireEvent.click(submit());
      await waitFor(() => expect(loadMarketplaceFromDir).toHaveBeenCalledTimes(1));
      return { reading, view, window: marketplaceWindow() };
    }

    it('steps aside with what was typed, is not closed, and returns still reading', async () => {
      const { reading, view, window } = await startReading();

      view.rerender(<Owner approval />);
      expect(screen.getByRole('alertdialog', { name: 'Confirm Action' })).toBeInTheDocument();
      expect(marketplaceWindow()).toBe(window);
      expect(window).toHaveAttribute('hidden');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.queryByRole('alertdialog', { name: getI18n().designSystem.discardTitle })).toBeNull();
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
      expect(onApprovalAnswer.mock.calls).toEqual([[false]]);
      expect(onClose).not.toHaveBeenCalled();

      view.rerender(<Owner approval={false} />);
      expect(marketplaceWindow()).toBe(window);
      expect(window).not.toHaveAttribute('hidden');
      expect(input().value).toBe('/markets/demo');
      expect(submit()).toHaveAttribute('aria-disabled', 'true');
      expect(onClose).not.toHaveBeenCalled();

      await act(async () => { reading.resolve(demo); });
      expect(addMarketplace).toHaveBeenCalledTimes(1);
      expect(onAdded).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(loadMarketplaceFromDir).toHaveBeenCalledTimes(1);
    });

    it('leaves through its own onClose when the read ends behind the approval, and does not come back', async () => {
      const { reading, view } = await startReading();
      view.rerender(<Owner approval />);
      expect(marketplaceWindow()).toHaveAttribute('hidden');

      await act(async () => { reading.resolve(demo); });
      expect(calls).toEqual(['addMarketplace:demo-market:/real/markets/demo', 'onAdded:demo-market', 'onClose']);
      expect(onApprovalAnswer).not.toHaveBeenCalled();

      view.rerender(<Owner approval={false} />);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('shows why the read failed when it fails behind the approval and the window returns', async () => {
      const { reading, view, window } = await startReading();
      view.rerender(<Owner approval />);

      await act(async () => { reading.reject(new Error('unreadable')); });
      expect(onClose).not.toHaveBeenCalled();
      expect(marketplaceWindow()).toBe(window);

      view.rerender(<Owner approval={false} />);
      expect(window).not.toHaveAttribute('hidden');
      expect(screen.getByText(tb().pluginsMarketplaceFolderFailed)).toBeInTheDocument();
      expect(input().value).toBe('/markets/demo');
      expect(onClose).not.toHaveBeenCalled();
    });
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
