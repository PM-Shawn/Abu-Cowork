// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { initLanguage } from '@/i18n';
import { DesignSystemProvider } from '@/components/ds/provider';
import { TOAST_SETTLE_MS } from '@/components/ds/styles';
import { useAppStore } from '@/stores/appStore';
import { DEFAULT_APP_CONFIG } from '@/data/defaultAppConfig';
import type { AppDefinition } from '@/types/app';
import AppSwitcher from './AppSwitcher';

// The organization's app policy (technical plan §5): an employee who may not
// leave the app it provides sees neither 通用 nor 退出, while the organization's
// other apps stay switchable. The rest pins the menu itself and 移除.
const policy = vi.hoisted(() => ({ value: { defaultAppId: null as string | null, allowExit: true } }));
vi.mock('@/core/enterprise/appPolicy', () => ({ useEnterpriseAppPolicy: () => policy.value }));
// Removing reaches the disk through `removeApp`; its own tests cover that.
const removeApp = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@/core/app/appSync', () => ({ removeApp }));

const app = (appId: string, name: string, origin: AppDefinition['origin']): AppDefinition => ({
  appId, name, config: DEFAULT_APP_CONFIG, version: '1.0.0', origin, plugins: [],
});
const shop = app('enterprise-app:shop', '店铺运营', { kind: 'enterprise' });
const hr = app('enterprise-app:hr', '招聘', { kind: 'enterprise' });
const recruiting = app('recruiting@abu-official', '招聘助手', { kind: 'market', market: 'abu-official' });
const weekly = app('weekly@mine', '周报', { kind: 'created', authoringId: 'a1' });

function renderSwitcher() {
  return render(<AppSwitcher />, { wrapper: DesignSystemProvider });
}

beforeAll(() => {
  // happy-dom lacks the pointer-capture and scroll APIs Radix menus call.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});
beforeEach(() => {
  initLanguage('zh-CN');
  policy.value = { defaultAppId: null, allowExit: true };
  removeApp.mockClear();
  useAppStore.setState({ addedApps: [recruiting, weekly], managedApps: { enterprise: [shop, hr] }, recentAppIds: [], selectedAppId: shop.appId, appMarketOpen: false });
});
afterEach(() => {
  cleanup();
  useAppStore.setState({ addedApps: [], managedApps: {}, recentAppIds: [], selectedAppId: '__general__', appMarketOpen: false });
});

describe('AppSwitcher', () => {
  it('offers 通用 in a personal install, which is how the user leaves an app', async () => {
    const user = userEvent.setup();
    renderSwitcher();
    await user.click(screen.getByTestId('app-switcher-trigger'));
    await user.click(screen.getByTestId('app-switcher-item-__general__'));
    expect(useAppStore.getState().selectedAppId).toBe('__general__');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('drops it once the organization keeps the employee inside its app, and still lists its other apps', async () => {
    const user = userEvent.setup();
    policy.value = { defaultAppId: shop.appId, allowExit: false };
    renderSwitcher();
    await user.click(screen.getByTestId('app-switcher-trigger'));
    expect(screen.queryByTestId('app-switcher-item-__general__')).not.toBeInTheDocument();
    expect(screen.getByTestId(`app-switcher-item-${hr.appId}`)).toBeInTheDocument();
  });

  it('keeps its reader name and opens a design-system menu that marks the current app', async () => {
    const user = userEvent.setup();
    renderSwitcher();
    const trigger = screen.getByRole('button', { name: '切换应用' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(screen.getByTestId('app-switcher-current')).toHaveTextContent('店铺运营');
    await user.click(trigger);
    const menu = screen.getByRole('menu');
    expect(menu).toHaveAttribute('data-ds-layer');
    expect(menu).toHaveAttribute('data-electron-no-drag');
    expect(within(menu).getByTestId('app-switcher-menu')).toBeInTheDocument();
    // The rows are one radio group: the current app is checked and has no 进入 hint.
    const current = screen.getByRole('menuitemradio', { name: /店铺运营/ });
    expect(current).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemradio', { name: /^招聘$/ })).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByTestId(`app-switcher-enter-${shop.appId}`)).toBeNull();
    expect(screen.getByTestId(`app-switcher-enter-${hr.appId}`)).toHaveTextContent('进入');
  });

  it('is a small quiet pill as wide as its words, filled darker while its menu is open', async () => {
    const user = userEvent.setup();
    renderSwitcher();
    const trigger = screen.getByTestId('app-switcher-trigger');
    const classes = () => trigger.className.split(/\s+/);
    expect(classes()).toEqual(expect.arrayContaining(['h-6', 'text-ui-sm', 'rounded-full', 'max-w-full', 'font-normal', 'text-label-secondary']));
    // It takes the room its words need: a full-width switcher reads as a navigation row.
    expect(classes()).not.toContain('w-full');
    expect(classes()).not.toContain('font-medium');
    expect(classes()).toContain('aria-expanded:bg-fill-selected');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  describe('once the menu has gone', () => {
    beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
    afterEach(() => { vi.useRealTimers(); });

    const setUp = () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderSwitcher();
      return user;
    };
    const flush = () => act(async () => { await Promise.resolve(); });
    /** Opens the menu, its 移除 list, and chooses the app there. */
    async function chooseRemove(user: ReturnType<typeof userEvent.setup>, target: AppDefinition) {
      await user.click(screen.getByTestId('app-switcher-trigger'));
      await user.click(screen.getByTestId('app-switcher-remove'));
      // A click with no pointer travel: happy-dom gives the lists no size, so a pointer that
      // leaves the 移除 row would close its list before it arrives.
      fireEvent.click(await screen.findByTestId(`app-switcher-remove-${target.appId}`));
      await vi.runOnlyPendingTimersAsync();
      await flush();
    }
    const question = () => screen.queryByRole('alertdialog');
    const confirmButton = () => within(question()!).getByRole('button', { name: '移除' });
    const settle = () => act(() => { vi.advanceTimersByTime(TOAST_SETTLE_MS); });

    it('opens the app market', async () => {
      const user = setUp();
      await user.click(screen.getByTestId('app-switcher-trigger'));
      await user.click(screen.getByTestId('app-switcher-discover'));
      await vi.runOnlyPendingTimersAsync();
      expect(screen.queryByRole('menu')).toBeNull();
      expect(useAppStore.getState().appMarketOpen).toBe(true);
    });

    it('lists under 移除 the apps the user added and no organization app', async () => {
      const user = setUp();
      await user.click(screen.getByTestId('app-switcher-trigger'));
      await user.click(screen.getByTestId('app-switcher-remove'));
      expect(await screen.findByTestId(`app-switcher-remove-${recruiting.appId}`)).toHaveTextContent('招聘助手');
      expect(screen.getByTestId(`app-switcher-remove-${weekly.appId}`)).toHaveTextContent('周报');
      expect(screen.queryByTestId(`app-switcher-remove-${hr.appId}`)).not.toBeInTheDocument();
      expect(screen.queryByTestId('app-switcher-remove-__general__')).not.toBeInTheDocument();
    });

    it('offers no 移除 when every app comes from the organization', async () => {
      useAppStore.setState({ addedApps: [] });
      const user = setUp();
      await user.click(screen.getByTestId('app-switcher-trigger'));
      expect(screen.queryByTestId('app-switcher-remove')).not.toBeInTheDocument();
    });

    it('removes a market app at once, without entering it, and leaves the focus on the switcher', async () => {
      const user = setUp();
      await chooseRemove(user, recruiting);
      expect(question()).toBeNull();
      expect(removeApp).toHaveBeenCalledExactlyOnceWith(recruiting.appId);
      expect(useAppStore.getState().selectedAppId).toBe(shop.appId);
      expect(screen.getByTestId('app-switcher-trigger')).toHaveFocus();
    });

    it('asks before removing an app the user made, naming it, and removes it on one press of 移除', async () => {
      const user = setUp();
      await chooseRemove(user, weekly);
      expect(removeApp).not.toHaveBeenCalled();
      expect(question()).toHaveAccessibleName('移除「周报」？');
      expect(question()).toHaveTextContent('这个应用是你自己做的，移除以后不能再添加回来');

      settle();
      act(() => {
        fireEvent.click(confirmButton(), { detail: 1 });
        fireEvent.click(confirmButton(), { detail: 1 });
      });
      await flush();
      expect(removeApp).toHaveBeenCalledExactlyOnceWith(weekly.appId);
    });

    it('takes no pointer press on the question before it has settled', async () => {
      const user = setUp();
      await chooseRemove(user, weekly);
      const button = confirmButton();
      fireEvent.pointerDown(button);
      fireEvent.click(button, { detail: 1 });
      await flush();
      expect(removeApp).not.toHaveBeenCalled();
      expect(question()).not.toBeNull();
    });

    it('removes nothing on 取消, on Escape, or from an Enter held since the menu', async () => {
      const user = setUp();
      await chooseRemove(user, weekly);
      const cancel = within(question()!).getByRole('button', { name: '取消' });
      expect(cancel).toHaveFocus();
      // The repeats of a key that was down before the question appeared.
      for (let i = 0; i < 5; i += 1) {
        expect(fireEvent.keyDown(confirmButton(), { key: 'Enter', code: 'Enter', repeat: true })).toBe(false);
      }
      await flush();
      expect(question()).not.toBeNull();

      fireEvent.keyDown(cancel, { key: 'Escape', code: 'Escape' });
      await flush();
      expect(removeApp).not.toHaveBeenCalled();

      await vi.runOnlyPendingTimersAsync();
      await chooseRemove(user, weekly);
      fireEvent.click(within(question()!).getByRole('button', { name: '取消' }));
      await flush();
      expect(removeApp).not.toHaveBeenCalled();
    });

    it('removes nothing when the app has left the list by the time the question is answered', async () => {
      const user = setUp();
      await chooseRemove(user, weekly);
      act(() => { useAppStore.setState({ addedApps: [recruiting] }); });
      fireEvent.click(confirmButton());
      await flush();
      expect(removeApp).not.toHaveBeenCalled();
    });

    it('can remove the same app again after a removal that failed', async () => {
      removeApp.mockRejectedValueOnce(new Error('disk is read-only'));
      const user = setUp();
      await chooseRemove(user, recruiting);
      await flush();
      await chooseRemove(user, recruiting);
      expect(removeApp).toHaveBeenCalledTimes(2);
    });
  });
});
