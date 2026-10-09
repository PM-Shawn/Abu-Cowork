// @vitest-environment happy-dom
/**
 * The confirmation between 「使用」 / 「更新」 / 「从文件夹添加」 and the app. It
 * adds an app and installs plugins, so what matters most here is that only its
 * own confirming button confirms, once, and that everything else leaves the
 * computer as it was.
 */

import type { ReactElement } from 'react';
import { act, fireEvent, render as renderBare, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { keepClosingLayersOnScreen } from '@/test/dsWindows';

vi.mock('@/core/app/appInstaller', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/app/appInstaller')>()),
  planAddApp: vi.fn(),
  planPluginSteps: vi.fn(),
  confirmAddApp: vi.fn(),
  runPluginSteps: vi.fn(),
  cancelPluginSteps: vi.fn().mockResolvedValue(undefined),
}));

import { cancelPluginSteps, confirmAddApp, planAddApp, planPluginSteps, runPluginSteps, type AppAddPlan, type AppPluginStep } from '@/core/app/appInstaller';
import type { InstallDisclosure } from '@/core/plugin/installer';
import { DEFAULT_APP_CONFIG } from '@/data/defaultAppConfig';
import { getI18n, format } from '@/i18n';
import { useAppAddFlowStore, type AppAddFlow } from '@/stores/appAddFlowStore';
import { useAppStore } from '@/stores/appStore';
import type { AppDefinition } from '@/types/app';
import AppAddConfirmDialog from './AppAddConfirmDialog';

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });
const copy = () => getI18n().appMarket;
const common = () => getI18n().common;
const flush = () => act(async () => { await Promise.resolve(); });

const disclosure = (name: string, env: Record<string, string> = {}): InstallDisclosure => ({
  key: `${name}@acme`,
  name,
  marketplace: 'acme',
  version: '1.0.0',
  manifest: { name, version: '1.0.0', mcpServers: { api: { command: 'node', args: ['server.js'], env } } } as unknown as InstallDisclosure['manifest'],
  sourceDir: `/m/acme/plugins/${name}`,
  skills: ['product-listing'],
  mcpServers: [{ name: 'api', command: 'node', args: ['server.js'] }],
  agents: [],
  ignoredPayloads: [],
});
const step = (kind: AppPluginStep['kind'], name: string, env?: Record<string, string>): AppPluginStep => ({
  kind,
  marketplace: { name: 'acme', dir: '/m/acme' },
  entry: { name, source: { kind: 'relative', path: `./plugins/${name}` } },
  disclosure: disclosure(name, env),
});
const shop: AppDefinition = {
  appId: 'shop-ops@acme',
  name: '店铺运营',
  description: '每天看店',
  config: {
    ...DEFAULT_APP_CONFIG,
    home: { modes: { items: [{ modeId: 'sourcing', title: '选品', scenes: [{ id: 'shortlist', title: '选品清单', templates: [] }] }] } },
  },
  version: '1.0.0',
  origin: { kind: 'market', market: 'acme' },
  plugins: ['shop-assistant'],
};
const plan = (more: Partial<AppAddPlan> = {}): AppAddPlan => ({
  appId: shop.appId,
  origin: { kind: 'market', market: 'acme' },
  sourceDir: '/m/acme/apps/shop-ops',
  file: {} as AppAddPlan['file'],
  app: shop,
  steps: [step('install', 'shop-assistant')],
  sites: ['https://portal.example.test'],
  replacing: false,
  ...more,
});
const ready = (purpose: 'add' | 'update' | 'preview' = 'add', more: Partial<AppAddPlan> = {}): AppAddFlow => ({ kind: 'ready', purpose, plan: plan(more) });

/** Puts the flow in the store the way `start` and `repair` do from the page. */
const flowIs = (flow: AppAddFlow) => act(() => { useAppAddFlowStore.setState({ flow, shownIn: 'page' }); });
const dialog = () => screen.queryByTestId('app-add-dialog');
const confirmButton = () => screen.getByTestId('app-add-confirm');
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(confirmAddApp).mockResolvedValue(undefined);
  vi.mocked(runPluginSteps).mockResolvedValue(undefined);
  useAppAddFlowStore.setState({ flow: { kind: 'closed' }, running: false, shownIn: 'page' });
  useAppStore.setState({ appMarketOpen: false });
});

describe('AppAddConfirmDialog', () => {
  it('is not on the page while no flow is under way', () => {
    render(<AppAddConfirmDialog within="page" />);
    expect(dialog()).toBeNull();
  });

  // The app root and, while the app market's content is on the page, the market.
  function Both({ market }: { market: boolean }) {
    return <><AppAddConfirmDialog within="page" />{market && <div data-testid="in-market"><AppAddConfirmDialog within="market" /></div>}</>;
  }
  const startAdd = () => act(async () => { await useAppAddFlowStore.getState().start({ kind: 'folder', dir: '/Users/testuser/dev/shop-ops' }, '店铺运营', 'add'); });

  describe('which of the two shows a flow', () => {
    beforeEach(() => { vi.mocked(planAddApp).mockResolvedValue(plan()); });

    it('the one on the page, for a flow started while the app market is closed', async () => {
      render(<Both market />);
      await startAdd();
      expect(screen.getAllByTestId('app-add-dialog')).toHaveLength(1);
      expect(useAppAddFlowStore.getState().shownIn).toBe('page');
    });

    it('the one in the market, for a flow started while the app market is open, and it stays there when the market closes', async () => {
      act(() => { useAppStore.setState({ appMarketOpen: true }); });
      const page = render(<AppAddConfirmDialog within="page" />);
      await startAdd();
      expect(useAppAddFlowStore.getState().shownIn).toBe('market');
      expect(dialog()).toBeNull();
      // Entering the app closes the market a moment before the flow ends: the page's window does not open for it.
      act(() => { useAppStore.setState({ appMarketOpen: false }); });
      expect(dialog()).toBeNull();
      page.unmount();

      useAppAddFlowStore.setState({ flow: { kind: 'closed' } });
      act(() => { useAppStore.setState({ appMarketOpen: true }); });
      render(<AppAddConfirmDialog within="market" />);
      await startAdd();
      expect(dialog()).not.toBeNull();
    });

    it('a scene\'s repair started on the app home shows on the page', async () => {
      vi.mocked(planPluginSteps).mockResolvedValue([step('install', 'shop-assistant')]);
      render(<Both market />);
      await act(async () => { await useAppAddFlowStore.getState().repair(shop, vi.fn()); });
      expect(useAppAddFlowStore.getState().shownIn).toBe('page');
      expect(screen.getAllByTestId('app-add-dialog')).toHaveLength(1);
      expect(dialog()).toHaveAccessibleName(copy().needInstall);
    });
  });

  describe('a flow whose window in the app market leaves the page', () => {
    async function shownInTheMarket() {
      vi.mocked(planAddApp).mockResolvedValue(plan());
      act(() => { useAppStore.setState({ appMarketOpen: true }); });
      const view = renderBare(<Both market />, { wrapper: DesignSystemProvider });
      await startAdd();
      expect(screen.getAllByTestId('app-add-dialog')).toHaveLength(1);
      // The market is closed by code and its content, the window included, leaves the page.
      const marketLeaves = () => {
        act(() => { useAppStore.setState({ appMarketOpen: false }); });
        view.rerender(<Both market={false} />);
      };
      return { marketLeaves };
    }

    it('while it adds: a failure shows on the page, Close ends the flow, and the next add shows its window', async () => {
      const adding = deferred();
      vi.mocked(confirmAddApp).mockReturnValue(adding.promise);
      const { marketLeaves } = await shownInTheMarket();
      fireEvent.click(confirmButton());
      await flush();
      expect(useAppAddFlowStore.getState().running).toBe(true);
      marketLeaves();

      await act(async () => { adding.reject(new Error('disk is full')); });
      await waitFor(() => expect(screen.getByTestId('app-add-error')).toHaveTextContent('disk is full'));
      expect(screen.getAllByTestId('app-add-dialog')).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: common().close }));
      await flush();
      expect(useAppAddFlowStore.getState().flow.kind).toBe('closed');

      await startAdd();
      expect(dialog()).toHaveAccessibleName(format(copy().confirmAddTitle, { name: '店铺运营' }));
      expect(confirmButton()).toBeEnabled();
    });

    it('while it waits for an answer: the page shows it, and one press on its confirming button adds once', async () => {
      const { marketLeaves } = await shownInTheMarket();
      marketLeaves();

      expect(screen.getAllByTestId('app-add-dialog')).toHaveLength(1);
      expect(dialog()).toHaveAccessibleName(format(copy().confirmAddTitle, { name: '店铺运营' }));
      const adding = deferred();
      vi.mocked(confirmAddApp).mockReturnValue(adding.promise);
      const button = confirmButton();
      // The repeats of an Enter held from elsewhere add nothing.
      expect(fireEvent.keyDown(button, { key: 'Enter', code: 'Enter', repeat: true })).toBe(false);
      await flush();
      expect(confirmAddApp).not.toHaveBeenCalled();

      fireEvent.click(button);
      fireEvent.click(button);
      await flush();
      expect(fireEvent.keyDown(confirmButton(), { key: 'Enter', code: 'Enter', repeat: true })).toBe(false);
      fireEvent.click(confirmButton());
      await flush();
      expect(confirmAddApp).toHaveBeenCalledTimes(1);

      await act(async () => { adding.resolve(); });
      expect(useAppAddFlowStore.getState().flow.kind).toBe('closed');
      expect(confirmAddApp).toHaveBeenCalledTimes(1);
    });
  });

  describe('what it shows', () => {
    beforeEach(() => { render(<AppAddConfirmDialog within="page" />); });

    it('says it is loading while the app is read, with Close as its one button', () => {
      flowIs({ kind: 'planning', name: '店铺运营' });
      expect(dialog()).toHaveAccessibleName(format(copy().confirmAddTitle, { name: '店铺运营' }));
      expect(screen.getByRole('status')).toHaveTextContent(common().loading);
      expect(screen.queryByTestId('app-add-confirm')).toBeNull();
      expect(screen.getAllByRole('button', { name: common().close })).toHaveLength(1);
    });

    it('names the app, lists the plugins to install as the plugin install window does, and the websites it opens', () => {
      flowIs(ready('add', { steps: [step('install', 'shop-assistant'), step('update', 'shop-reports')] }));
      expect(dialog()).toHaveAccessibleName(format(copy().confirmAddTitle, { name: '店铺运营' }));
      expect(dialog()).toHaveTextContent('每天看店');
      const groups = screen.getAllByTestId('app-add-plugins');
      expect(groups[0]).toHaveTextContent(copy().needInstall);
      expect(within(groups[0]).getByTestId('app-add-plugin')).toHaveAttribute('data-plugin', 'shop-assistant');
      expect(groups[1]).toHaveTextContent(copy().needUpdate);
      expect(within(groups[1]).getByTestId('app-add-plugin')).toHaveAttribute('data-plugin', 'shop-reports');
      // The literal command line of every connector, as in the plugin install window.
      expect(screen.getAllByTestId('plugin-disclosure-server')[0]).toHaveTextContent('node server.js');
      expect(screen.getByTestId('app-add-sites')).toHaveTextContent('https://portal.example.test');
      expect(screen.queryByTestId('app-add-scenes')).toBeNull();
    });

    it('titles an update and a folder preview after what they do; the preview lists the scenes and who handles each', () => {
      flowIs(ready('update'));
      expect(dialog()).toHaveAccessibleName(format(copy().confirmUpdateTitle, { name: '店铺运营' }));
      flowIs(ready('preview'));
      expect(dialog()).toHaveAccessibleName(format(copy().previewTitle, { name: '店铺运营' }));
      expect(screen.getByTestId('app-add-scenes')).toHaveTextContent('选品 · 选品清单');
      expect(screen.getByTestId('app-add-scenes')).toHaveTextContent(getI18n().appHome.sceneRunDefault);
    });

    it('says why an add failed, with Close as its one button', () => {
      flowIs({ kind: 'error', name: '店铺运营', message: 'the plugin shop-assistant is not in any market' });
      expect(dialog()).toHaveAccessibleName(copy().addFailed);
      expect(within(screen.getByTestId('app-add-error')).getByRole('alert')).toHaveTextContent('the plugin shop-assistant is not in any market');
      expect(screen.queryByTestId('app-add-confirm')).toBeNull();
      expect(screen.getAllByRole('button', { name: common().close })).toHaveLength(1);
    });

    it('waits for every value a plugin asks for, in masked fields, and forgets them with the flow', () => {
      flowIs(ready('add', { steps: [step('install', 'shop-assistant', { TOKEN: '${config.SHOP_TOKEN}' })] }));
      const field = screen.getByLabelText('SHOP_TOKEN') as HTMLInputElement;
      expect(field).toHaveAttribute('type', 'password');
      expect(confirmButton()).toBeDisabled();
      fireEvent.change(field, { target: { value: 'not-a-real-token' } });
      expect(confirmButton()).toBeEnabled();

      flowIs(ready('add', { steps: [step('install', 'shop-assistant', { TOKEN: '${config.SHOP_TOKEN}' })] }));
      expect((screen.getByLabelText('SHOP_TOKEN') as HTMLInputElement).value).toBe('');
      expect(confirmButton()).toBeDisabled();
    });
  });

  describe('confirming', () => {
    beforeEach(() => { render(<AppAddConfirmDialog within="page" />); });

    it('adds the app with the values typed, on one press of its confirming button', async () => {
      flowIs(ready('add', { steps: [step('install', 'shop-assistant', { TOKEN: '${config.SHOP_TOKEN}' })] }));
      fireEvent.change(screen.getByLabelText('SHOP_TOKEN'), { target: { value: 'not-a-real-token' } });
      expect(confirmButton()).toHaveTextContent(copy().confirm);
      fireEvent.click(confirmButton());
      await flush();
      expect(confirmAddApp).toHaveBeenCalledTimes(1);
      expect(vi.mocked(confirmAddApp).mock.calls[0][2]).toEqual({ 'shop-assistant@acme': { SHOP_TOKEN: 'not-a-real-token' } });
      await waitFor(() => expect(useAppAddFlowStore.getState().flow.kind).toBe('closed'));
    });

    it('takes a second press while it is adding as nothing, keeps the focus on the button, and cannot be left', async () => {
      const adding = deferred();
      vi.mocked(confirmAddApp).mockReturnValue(adding.promise);
      flowIs(ready());
      confirmButton().focus();
      fireEvent.click(confirmButton());
      await flush();

      // Busy, never disabled: a disabled button would drop the keyboard focus onto the window.
      expect(confirmButton()).toHaveAttribute('aria-disabled', 'true');
      expect(confirmButton()).not.toBeDisabled();
      expect(confirmButton()).toHaveFocus();
      expect(confirmButton()).toHaveTextContent(copy().adding);
      fireEvent.click(confirmButton());
      fireEvent.keyDown(confirmButton(), { key: 'Escape', code: 'Escape' });
      expect(screen.getByRole('button', { name: common().cancel })).toBeDisabled();
      // The corner button is off while it adds.
      expect(screen.queryByRole('button', { name: common().close })).toBeNull();
      await flush();
      expect(confirmAddApp).toHaveBeenCalledTimes(1);
      expect(cancelPluginSteps).not.toHaveBeenCalled();
      expect(useAppAddFlowStore.getState().flow.kind).toBe('ready');

      await act(async () => { adding.resolve(); });
      expect(useAppAddFlowStore.getState().flow.kind).toBe('closed');
    });

    it('is not confirmed by Enter held from elsewhere, nor by its repeats on the confirming button', async () => {
      flowIs(ready());
      const button = confirmButton();
      for (let i = 0; i < 5; i += 1) {
        // fireEvent returns false once the default was prevented: the browser makes no click.
        expect(fireEvent.keyDown(button, { key: 'Enter', code: 'Enter', repeat: true })).toBe(false);
      }
      await flush();
      expect(confirmAddApp).not.toHaveBeenCalled();
      expect(useAppAddFlowStore.getState().flow.kind).toBe('ready');
    });

    it('writes nothing on Cancel, on Escape and on the corner button, and releases what was prepared', async () => {
      for (const leave of [
        () => fireEvent.click(screen.getByRole('button', { name: common().cancel })),
        () => fireEvent.keyDown(confirmButton(), { key: 'Escape', code: 'Escape' }),
        () => fireEvent.click(screen.getByRole('button', { name: common().close })),
      ]) {
        vi.mocked(cancelPluginSteps).mockClear();
        const flow = ready();
        flowIs(flow);
        leave();
        await flush();
        expect(useAppAddFlowStore.getState().flow.kind).toBe('closed');
        expect(cancelPluginSteps).toHaveBeenCalledExactlyOnceWith(flow.kind === 'ready' ? flow.plan.steps : []);
      }
      expect(confirmAddApp).not.toHaveBeenCalled();
    });

    it('says why when adding fails, and adds nothing more from there', async () => {
      vi.mocked(confirmAddApp).mockRejectedValue(new Error('disk is full'));
      flowIs(ready());
      fireEvent.click(confirmButton());
      await waitFor(() => expect(screen.getByTestId('app-add-error')).toHaveTextContent('disk is full'));
      expect(screen.queryByTestId('app-add-confirm')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: common().close }));
      await flush();
      expect(useAppAddFlowStore.getState().flow.kind).toBe('closed');
    });

    it('installs the plugin a scene needs again and then starts what the user pressed', async () => {
      const resume = vi.fn();
      const steps = [step('install', 'shop-assistant')];
      flowIs({ kind: 'repair', app: shop, steps, resume });
      expect(dialog()).toHaveAccessibleName(copy().needInstall);
      expect(screen.getByTestId('app-add-plugin')).toHaveAttribute('data-plugin', 'shop-assistant');
      fireEvent.click(confirmButton());
      await waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
      expect(runPluginSteps).toHaveBeenCalledTimes(1);
      expect(vi.mocked(runPluginSteps).mock.calls[0][0]).toBe(steps);
      expect(confirmAddApp).not.toHaveBeenCalled();
    });

    it('starts nothing when a repair is cancelled', async () => {
      const resume = vi.fn();
      flowIs({ kind: 'repair', app: shop, steps: [step('install', 'shop-assistant')], resume });
      fireEvent.click(screen.getByRole('button', { name: common().cancel }));
      await flush();
      expect(resume).not.toHaveBeenCalled();
      expect(runPluginSteps).not.toHaveBeenCalled();
    });
  });

  describe('while the window fades out', () => {
    it('keeps showing the app, and a press on its buttons confirms and cancels nothing', async () => {
      const computedStyle = keepClosingLayersOnScreen();
      try {
        render(<AppAddConfirmDialog within="page" />);
        flowIs(ready());
        flowIs({ kind: 'closed' });
        expect(document.querySelector('[role="dialog"][data-state="closed"]')).not.toBeNull();
        expect(dialog()).toHaveTextContent('店铺运营');
        expect(screen.getByTestId('app-add-plugin')).toHaveAttribute('data-plugin', 'shop-assistant');

        // A flow that started meanwhile in the other window is not this window's to answer.
        act(() => { useAppAddFlowStore.setState({ flow: ready('update'), shownIn: 'market' }); });
        fireEvent.click(screen.getByTestId('app-add-confirm'));
        fireEvent.click(screen.getByRole('button', { name: common().cancel, hidden: true }));
        await flush();

        expect(confirmAddApp).not.toHaveBeenCalled();
        expect(cancelPluginSteps).not.toHaveBeenCalled();
        expect(useAppAddFlowStore.getState().flow.kind).toBe('ready');
      } finally {
        computedStyle.mockRestore();
      }
    });
  });
});
