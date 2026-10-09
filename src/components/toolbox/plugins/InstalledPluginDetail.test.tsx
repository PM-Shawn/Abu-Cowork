// @vitest-environment happy-dom
/**
 * The detail window of an installed plugin: what the plugin brought, its
 * switch, its menu, the page that says where it came from, and what the
 * window does while it fades out.
 */

import type { ReactElement } from 'react';
import { act, fireEvent, render as renderBare, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';

// The detail window is a design-system dialog, so it renders inside the provider like the app does.
const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

vi.mock('@/core/plugin/installedStore', () => ({
  readInstalled: vi.fn().mockResolvedValue([]),
  readInstalledResult: vi.fn().mockResolvedValue({ ok: true, plugins: [] }),
  upsertInstalled: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/core/permissions/pluginToolPolicy', () => ({ setPluginServerNames: vi.fn() }));

import type { InstalledPlugin } from '@/core/plugin/installedStore';
import { usePluginStore } from '@/stores/pluginStore';
import { format, getI18n, initLanguage } from '@/i18n';
import InstalledPluginDetail from './InstalledPluginDetail';

const shop: InstalledPlugin = {
  key: 'shop@official',
  marketplace: 'official',
  name: 'shop',
  version: '1.0.0',
  installedAt: '2026-09-19T00:00:00.000Z',
  contributed: { skills: ['product-listing'], mcpServers: ['shop-api'], agents: [], teams: ['store-ops'] },
};

describe('InstalledPluginDetail: the window and its controls', () => {
  beforeAll(() => {
    // happy-dom lacks the pointer-capture and scroll APIs Radix menus call.
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.releasePointerCapture ??= () => {};
    Element.prototype.scrollIntoView ??= () => {};
  });
  const tb = () => getI18n().toolbox;
  const pinned: InstalledPlugin = { ...shop, sha: 'sha-pinned-0123456789abcdef' };
  const enabledShop = { [shop.key]: { enabled: true, root: '/Users/tester/.abu/plugin-packages/official/shop/1.0.0', skillDirs: [], legacySkills: true, agentFiles: [], mcpServers: ['shop-api'] } };

  function open(overrides: Partial<React.ComponentProps<typeof InstalledPluginDetail>> = {}) {
    const props = { home: '/Users/tester', plugin: pinned, onClose: vi.fn(), onUninstall: vi.fn(), ...overrides };
    render(<InstalledPluginDetail {...props} />);
    return props;
  }
  const openMenuItem = async (testId: string) => {
    await userEvent.click(screen.getByTestId('plugin-detail-menu'));
    await userEvent.click(screen.getByTestId(testId));
  };

  beforeEach(() => {
    initLanguage('zh-CN');
    usePluginStore.setState({ activationByKey: {}, installed: [] });
  });

  it('is a window named after the plugin, whose heading adds what it is', () => {
    open();
    expect(screen.getByRole('dialog')).toHaveAccessibleName('shop');
    expect(screen.getByRole('heading', { level: 2, name: `shop ${tb().plugins}` })).toBeInTheDocument();
    // One heading says "shop" alone: the window's own hidden title.
    expect(screen.getAllByRole('heading', { name: 'shop' })).toHaveLength(1);
  });

  it('lists what the plugin brought and renders nothing without a plugin', () => {
    const view = renderBare(<InstalledPluginDetail home="/Users/tester" plugin={null} onClose={() => {}} onUninstall={() => {}} />, { wrapper: DesignSystemProvider });
    expect(screen.queryByRole('dialog')).toBeNull();
    view.unmount();
    open();
    const detail = screen.getByTestId('plugin-manage-dialog');
    expect(detail).toHaveTextContent('product-listing');
    expect(detail).toHaveTextContent('shop-api');
  });

  it('hands the record to the uninstall confirmation and uninstalls nothing itself', () => {
    const props = open();
    fireEvent.click(screen.getByRole('button', { name: tb().pluginsUninstall }));
    expect(props.onUninstall).toHaveBeenCalledExactlyOnceWith(pinned);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('names the switch after the plugin and turns the plugin off through the store', () => {
    const setPluginEnabled = vi.fn().mockResolvedValue(undefined);
    usePluginStore.setState({ activationByKey: enabledShop, setPluginEnabled });
    open();
    const toggle = screen.getByRole('switch', { name: 'shop' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(toggle);
    expect(setPluginEnabled).toHaveBeenCalledExactlyOnceWith(shop.key, false);
  });

  it('keeps the focus on the switch while the plugin is being turned on, and takes no second press', async () => {
    let finish!: () => void;
    const setPluginEnabled = vi.fn().mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    usePluginStore.setState({ activationByKey: { [shop.key]: { ...enabledShop[shop.key], enabled: false } }, setPluginEnabled });
    open();
    const toggle = screen.getByRole('switch', { name: 'shop' });
    toggle.focus();
    await userEvent.keyboard(' ');
    await waitFor(() => expect(setPluginEnabled).toHaveBeenCalledExactlyOnceWith(shop.key, true));

    // Busy, never disabled: a disabled control would drop the keyboard focus onto the window.
    expect(toggle).toHaveAttribute('aria-disabled', 'true');
    expect(toggle).not.toBeDisabled();
    expect(toggle).toHaveFocus();
    await userEvent.keyboard(' ');
    expect(setPluginEnabled).toHaveBeenCalledTimes(1);

    await act(async () => { finish(); });
    expect(toggle).not.toHaveAttribute('aria-disabled');
    expect(toggle).toHaveFocus();
  });

  it('offers a trial only while the plugin is on', () => {
    const off = renderBare(<InstalledPluginDetail home="/Users/tester" plugin={pinned} onClose={() => {}} onUninstall={() => {}} />, { wrapper: DesignSystemProvider });
    expect(screen.getByRole('button', { name: tb().menuTrial })).toBeDisabled();
    off.unmount();
    usePluginStore.setState({ activationByKey: enabledShop });
    open();
    expect(screen.getByRole('button', { name: tb().menuTrial })).toBeEnabled();
  });

  it('shows where the plugin came from on a page of its own, with the pinned revision in full', async () => {
    open();
    await openMenuItem('plugin-detail-menu-view');

    const source = await screen.findByTestId('plugin-source-dialog');
    expect(source).toHaveTextContent(format(tb().pluginsFromMarketplace, { name: 'official' }));
    expect(source).toHaveTextContent('v1.0.0');
    expect(source).toHaveTextContent('sha-pinned-0123456789abcdef');
    expect(screen.queryByTestId('plugin-manage-dialog')).toBeNull();
    // The page's own controls are gone with the details: no switch, no menu, no footer.
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByTestId('plugin-detail-menu')).toBeNull();
    expect(screen.queryByRole('button', { name: tb().pluginsUninstall })).toBeNull();
  });

  it('moves the focus to the way back on the source page, and to the menu button when it is left', async () => {
    open();
    await openMenuItem('plugin-detail-menu-view');

    const back = await screen.findByRole('button', { name: tb().backToDetails });
    await waitFor(() => expect(back).toHaveFocus());
    await userEvent.click(back);

    expect(screen.getByTestId('plugin-manage-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('plugin-detail-menu')).toHaveFocus();
  });

  it('opens on the details again for another plugin', async () => {
    const view = renderBare(<InstalledPluginDetail home="/Users/tester" plugin={pinned} onClose={() => {}} onUninstall={() => {}} />, { wrapper: DesignSystemProvider });
    await openMenuItem('plugin-detail-menu-view');
    await screen.findByTestId('plugin-source-dialog');

    view.rerender(<InstalledPluginDetail home="/Users/tester" plugin={{ ...pinned, key: 'other@official', name: 'other' }} onClose={() => {}} onUninstall={() => {}} />);
    expect(screen.getByTestId('plugin-manage-dialog')).toHaveTextContent('other');
    expect(screen.queryByTestId('plugin-source-dialog')).toBeNull();
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
    const detail = (plugin: InstalledPlugin | null, props: Partial<React.ComponentProps<typeof InstalledPluginDetail>>) => (
      <InstalledPluginDetail home="/Users/tester" plugin={plugin} description={plugin ? 'Sells things' : undefined} onClose={() => {}} onUninstall={() => {}} {...props} />
    );

    it('keeps showing the plugin while it fades out', () => {
      const computedStyle = keepClosingLayersOnScreen();
      try {
        const view = renderBare(detail(pinned, {}), { wrapper: DesignSystemProvider });
        view.rerender(detail(null, {}));

        expect(document.querySelector('[role="dialog"][data-state="closed"]')).not.toBeNull();
        const body = screen.getByTestId('plugin-manage-dialog');
        expect(body).toHaveTextContent('shop');
        expect(body).toHaveTextContent('Sells things');
        expect(body).toHaveTextContent('product-listing');
        expect(body).toHaveTextContent('shop-api');
      } finally {
        computedStyle.mockRestore();
      }
    });

    it('asks nothing and starts nothing from a window that is closing', () => {
      const computedStyle = keepClosingLayersOnScreen();
      try {
        const setPluginEnabled = vi.fn().mockResolvedValue(undefined);
        usePluginStore.setState({ activationByKey: enabledShop, setPluginEnabled });
        const props = { onClose: vi.fn(), onUninstall: vi.fn(), authorUpdate: { available: true, onReview: vi.fn() } };
        const view = renderBare(detail(pinned, props), { wrapper: DesignSystemProvider });
        view.rerender(detail(null, props));
        expect(document.querySelector('[role="dialog"][data-state="closed"]')).not.toBeNull();

        fireEvent.click(screen.getByRole('button', { name: tb().pluginsUninstall, hidden: true }));
        fireEvent.click(screen.getByRole('button', { name: tb().menuTrial, hidden: true }));
        fireEvent.click(screen.getByRole('button', { name: tb().pluginsPreviewUpdate, hidden: true }));
        fireEvent.click(screen.getByRole('switch', { name: 'shop', hidden: true }));

        expect(props.onUninstall).not.toHaveBeenCalled();
        expect(props.onClose).not.toHaveBeenCalled();
        expect(props.authorUpdate.onReview).not.toHaveBeenCalled();
        expect(setPluginEnabled).not.toHaveBeenCalled();
      } finally {
        computedStyle.mockRestore();
      }
    });
  });

  it('puts the author\'s own actions in the menu and marks an available update', async () => {
    const onReview = vi.fn();
    const onEdit = vi.fn();
    open({
      authorUpdate: { available: true, onReview },
      authorActions: [{ id: 'edit', label: tb().pluginsContinueEditing, onSelect: onEdit }],
    });
    expect(screen.getByTestId('plugin-manage-dialog')).toHaveTextContent(tb().pluginsAuthorUpdateAvailable);
    fireEvent.click(screen.getByRole('button', { name: tb().pluginsPreviewUpdate }));
    expect(onReview).toHaveBeenCalledTimes(1);

    await openMenuItem('plugin-detail-menu-edit');
    await waitFor(() => expect(onEdit).toHaveBeenCalledTimes(1));
  });
});
