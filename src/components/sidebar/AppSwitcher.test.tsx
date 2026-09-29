// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { initLanguage } from '@/i18n';
import { DesignSystemProvider } from '@/components/ds/provider';
import { useAppStore } from '@/stores/appStore';
import { DEFAULT_APP_CONFIG } from '@/data/defaultAppConfig';
import type { AppDefinition } from '@/types/app';
import AppSwitcher from './AppSwitcher';

// The organization's app policy (technical plan §5): an employee who may not
// leave the app it provides sees neither 通用 nor 退出, while the organization's
// other apps stay switchable. The rest pins the menu itself.
const policy = vi.hoisted(() => ({ value: { defaultAppId: null as string | null, allowExit: true } }));
vi.mock('@/core/enterprise/appPolicy', () => ({ useEnterpriseAppPolicy: () => policy.value }));

const app = (appId: string, name: string): AppDefinition => ({
  appId, name, config: DEFAULT_APP_CONFIG, pluginKey: appId, pluginVersion: '1.0.0',
});
const installed = [app('shop@org', '店铺运营'), app('hr@org', '招聘')];

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
  useAppStore.setState({ installedApps: installed, recentAppIds: [], selectedAppId: 'shop@org', appMarketOpen: false });
});
afterEach(() => {
  cleanup();
  useAppStore.setState({ installedApps: [], recentAppIds: [], selectedAppId: '__general__', appMarketOpen: false });
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
    policy.value = { defaultAppId: 'shop@org', allowExit: false };
    renderSwitcher();
    await user.click(screen.getByTestId('app-switcher-trigger'));
    expect(screen.queryByTestId('app-switcher-item-__general__')).not.toBeInTheDocument();
    expect(screen.getByTestId('app-switcher-item-hr@org')).toBeInTheDocument();
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
    expect(screen.getByRole('menuitemradio', { name: /招聘/ })).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByTestId('app-switcher-enter-shop@org')).toBeNull();
    expect(screen.getByTestId('app-switcher-enter-hr@org')).toHaveTextContent('进入');
  });

  it('opens the app market only after the menu has gone', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderSwitcher();
      await user.click(screen.getByTestId('app-switcher-trigger'));
      await user.click(screen.getByTestId('app-switcher-discover'));
      await vi.runOnlyPendingTimersAsync();
      expect(screen.queryByRole('menu')).toBeNull();
      expect(useAppStore.getState().appMarketOpen).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
