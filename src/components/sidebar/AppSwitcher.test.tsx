// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { initLanguage } from '@/i18n';
import { useAppStore } from '@/stores/appStore';
import { DEFAULT_APP_CONFIG } from '@/data/defaultAppConfig';
import type { AppDefinition } from '@/types/app';
import AppSwitcher from './AppSwitcher';

// The organization's app policy (technical plan §5) is the only thing this
// file covers: an employee who may not leave the app it provides sees neither
// 通用 nor 退出, while the organization's other apps stay switchable.
const policy = vi.hoisted(() => ({ value: { defaultAppId: null as string | null, allowExit: true } }));
vi.mock('@/core/enterprise/appPolicy', () => ({ useEnterpriseAppPolicy: () => policy.value }));

const app = (appId: string, name: string): AppDefinition => ({
  appId, name, config: DEFAULT_APP_CONFIG, pluginKey: appId, pluginVersion: '1.0.0',
});
const installed = [app('shop@org', '店铺运营'), app('hr@org', '招聘')];

beforeEach(() => {
  initLanguage('zh-CN');
  policy.value = { defaultAppId: null, allowExit: true };
  useAppStore.setState({ installedApps: installed, recentAppIds: [], selectedAppId: 'shop@org' });
});
afterEach(() => {
  cleanup();
  useAppStore.setState({ installedApps: [], recentAppIds: [], selectedAppId: '__general__' });
});

describe('AppSwitcher', () => {
  it('offers 通用 and 退出 in a personal install', () => {
    render(<AppSwitcher />);
    fireEvent.click(screen.getByTestId('app-switcher-trigger'));
    expect(screen.getByTestId('app-switcher-item-__general__')).toBeInTheDocument();
    expect(screen.getByTestId('app-switcher-exit')).toBeInTheDocument();
  });

  it('drops both once the organization keeps the employee inside its app, and still lists its other apps', () => {
    policy.value = { defaultAppId: 'shop@org', allowExit: false };
    render(<AppSwitcher />);
    fireEvent.click(screen.getByTestId('app-switcher-trigger'));
    expect(screen.queryByTestId('app-switcher-item-__general__')).not.toBeInTheDocument();
    expect(screen.queryByTestId('app-switcher-exit')).not.toBeInTheDocument();
    expect(screen.getByTestId('app-switcher-item-hr@org')).toBeInTheDocument();
  });
});
