// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import SystemSettingsDialog from '@/components/settings/SystemSettingsDialog';
import { __resetAccountStoreForTest } from '@/core/account/accountStore';
import { initLanguage } from '@/i18n';
import { usePreviewStore } from '@/stores/previewStore';
import { useSettingsStore } from '@/stores/settingsStore';
import AccountLoginDialog from './AccountLoginDialog';

// The sign-in window with the real settings store and the real settings window around it.
// The settings pages are replaced by the one button the account page has for signing in.
vi.mock('@/components/settings/SystemSettingsModal', async () => {
  const { Button } = await import('@/components/ds/button');
  const { useSettingsStore: store } = await import('@/stores/settingsStore');
  return {
    default: () => <Button onClick={() => store.getState().openAccountLogin()}>Sign in from the account page</Button>,
  };
});

const settingsWindow = () => document.querySelector('[data-abu-settings-dialog]');

describe('AccountLoginDialog opened from the settings window', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    __resetAccountStoreForTest();
    usePreviewStore.setState({ appModalOpen: false });
    useSettingsStore.setState({ systemSettingsOpen: true, accountLoginOpen: false });
  });
  afterEach(() => {
    useSettingsStore.setState({ systemSettingsOpen: false, accountLoginOpen: false });
  });

  it('closes the settings window and stands alone', async () => {
    const user = userEvent.setup();
    render(<><SystemSettingsDialog /><AccountLoginDialog /></>, { wrapper: DesignSystemProvider });
    expect(settingsWindow()).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Sign in from the account page' }));

    expect(useSettingsStore.getState().systemSettingsOpen).toBe(false);
    expect(useSettingsStore.getState().accountLoginOpen).toBe(true);
    expect(settingsWindow()).toBeNull();
    const dialogs = screen.getAllByRole('dialog');
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]).toHaveAccessibleName('登录 / 注册');
  });

  it('carries the markers the window is found by on the window and on its close button', async () => {
    const user = userEvent.setup();
    render(<><SystemSettingsDialog /><AccountLoginDialog /></>, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Sign in from the account page' }));

    const dialog = screen.getByRole('dialog', { name: '登录 / 注册' });
    expect(dialog).toHaveAttribute('data-abu-account-dialog');
    expect(dialog).toHaveAttribute('data-electron-no-drag');
    const close = document.querySelector('[data-abu-account-dialog-close]');
    expect(dialog).toContainElement(close as HTMLElement);
    expect(close).toHaveAccessibleName('关闭');
  });

  it('can be used once it is open: its buttons take the press and Escape closes only it', async () => {
    const user = userEvent.setup();
    render(<><SystemSettingsDialog /><AccountLoginDialog /></>, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Sign in from the account page' }));

    const dialog = screen.getByRole('dialog', { name: '登录 / 注册' });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard('{Escape}');
    expect(useSettingsStore.getState().accountLoginOpen).toBe(false);
    expect(useSettingsStore.getState().systemSettingsOpen).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
