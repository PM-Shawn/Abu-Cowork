// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { initLanguage } from '@/i18n';
import { useAppStore } from '@/stores/appStore';
import { DEFAULT_APP_CONFIG } from '@/data/defaultAppConfig';
import type { AppDefinition } from '@/types/app';
import AppSwitcher from './AppSwitcher';

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

beforeEach(() => {
  initLanguage('zh-CN');
  policy.value = { defaultAppId: null, allowExit: true };
  removeApp.mockClear();
  useAppStore.setState({ addedApps: [recruiting, weekly], managedApps: { enterprise: [shop, hr] }, recentAppIds: [], selectedAppId: shop.appId });
});
afterEach(() => {
  cleanup();
  useAppStore.setState({ addedApps: [], managedApps: {}, recentAppIds: [], selectedAppId: '__general__' });
});

describe('AppSwitcher', () => {
  it('offers 通用 in a personal install, which is how the user leaves an app', () => {
    render(<AppSwitcher />);
    fireEvent.click(screen.getByTestId('app-switcher-trigger'));
    fireEvent.click(screen.getByTestId('app-switcher-item-__general__'));
    expect(useAppStore.getState().selectedAppId).toBe('__general__');
  });

  it('drops it once the organization keeps the employee inside its app, and still lists its other apps', () => {
    policy.value = { defaultAppId: shop.appId, allowExit: false };
    render(<AppSwitcher />);
    fireEvent.click(screen.getByTestId('app-switcher-trigger'));
    expect(screen.queryByTestId('app-switcher-item-__general__')).not.toBeInTheDocument();
    expect(screen.getByTestId(`app-switcher-item-${hr.appId}`)).toBeInTheDocument();
  });

  it('offers 移除 on the apps the user added and not on organization apps', () => {
    render(<AppSwitcher />);
    fireEvent.click(screen.getByTestId('app-switcher-trigger'));
    expect(screen.getByTestId(`app-switcher-remove-${recruiting.appId}`)).toBeInTheDocument();
    expect(screen.getByTestId(`app-switcher-remove-${weekly.appId}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`app-switcher-remove-${hr.appId}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId('app-switcher-remove-__general__')).not.toBeInTheDocument();
  });

  it('removes a market app at once, without entering it', () => {
    render(<AppSwitcher />);
    fireEvent.click(screen.getByTestId('app-switcher-trigger'));
    fireEvent.click(screen.getByTestId(`app-switcher-remove-${recruiting.appId}`));
    expect(removeApp).toHaveBeenCalledWith(recruiting.appId);
    expect(useAppStore.getState().selectedAppId).toBe(shop.appId);
  });

  it('asks before removing an app the user made, because it cannot be added back', () => {
    render(<AppSwitcher />);
    fireEvent.click(screen.getByTestId('app-switcher-trigger'));
    fireEvent.click(screen.getByTestId(`app-switcher-remove-${weekly.appId}`));
    expect(removeApp).not.toHaveBeenCalled();
    expect(screen.getByText('这个应用是你自己做的，移除以后不能再添加回来')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '移除' }));
    expect(removeApp).toHaveBeenCalledWith(weekly.appId);
  });
});
