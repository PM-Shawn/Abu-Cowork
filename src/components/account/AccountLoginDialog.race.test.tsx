// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPkcePair } from '@/core/account/pkce';
import {
  __resetAccountStoreForTest,
  useAccountStore,
} from '@/core/account/accountStore';
import { initLanguage } from '@/i18n';
import AccountLoginDialog from './AccountLoginDialog';

const ui = vi.hoisted(() => ({
  close: vi.fn(),
  openSystemSettings: vi.fn(),
  state: {} as Record<string, unknown>,
}));
const startEnterpriseLogin = vi.hoisted(() => vi.fn());

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: Record<string, unknown>) => unknown) => selector(ui.state),
}));

vi.mock('@/config/featureGates', () => ({ IS_ENTERPRISE_BUILD: true }));

vi.mock('@/core/enterprise/accountLogin', () => ({
  startEnterpriseAccountLogin: startEnterpriseLogin,
}));

vi.mock('@/core/account/pkce', () => ({ createPkcePair: vi.fn() }));

vi.mock('@/core/account/client', async () => {
  const actual = await vi.importActual<typeof import('@/core/account/client')>('@/core/account/client');
  return {
    ...actual,
    PERSONAL_ACCOUNT_SERVER_URL: 'https://accounts.example.com',
  };
});

const PKCE = { verifier: 'verifier', challenge: 'challenge', state: 'state' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('AccountLoginDialog pending personal login', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    __resetAccountStoreForTest();
    ui.close.mockReset();
    ui.openSystemSettings.mockReset();
    startEnterpriseLogin.mockReset();
    startEnterpriseLogin.mockResolvedValue('started');
    ui.state = {
      accountLoginOpen: true,
      closeAccountLogin: ui.close,
      openSystemSettings: ui.openSystemSettings,
    };
    vi.mocked(createPkcePair).mockReset();
    vi.mocked(createPkcePair).mockResolvedValue(PKCE);
    vi.mocked(openUrl).mockReset();
    vi.mocked(openUrl).mockResolvedValue(undefined);
    vi.mocked(invoke).mockReset();
  });

  it('invalidates a personal login closed before protocol registration finishes', async () => {
    const registration = deferred<boolean>();
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'plugin:deep-link|is_registered') return await registration.promise;
      return undefined;
    });

    render(<AccountLoginDialog />);
    expect(screen.getByRole('button', { name: '个人账号登录' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '企业账号登录' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '个人账号登录' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));

    registration.resolve(true);

    await waitFor(() => expect(createPkcePair).toHaveBeenCalledOnce());
    expect(openUrl).not.toHaveBeenCalled();
    expect(useAccountStore.getState()).toMatchObject({
      status: 'signed_out',
      error: 'cancelled',
    });
    expect(ui.close).toHaveBeenCalledOnce();
  });

  it('invalidates a pending personal login before entering the enterprise flow', async () => {
    const registration = deferred<boolean>();
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'plugin:deep-link|is_registered') return await registration.promise;
      return undefined;
    });

    render(<AccountLoginDialog />);
    fireEvent.click(screen.getByRole('button', { name: '个人账号登录' }));
    fireEvent.click(screen.getByRole('button', { name: '企业账号登录' }));
    expect(ui.close).toHaveBeenCalledOnce();
    await waitFor(() => expect(startEnterpriseLogin).toHaveBeenCalledOnce());
    expect(ui.openSystemSettings).not.toHaveBeenCalled();

    registration.resolve(true);

    await waitFor(() => expect(createPkcePair).toHaveBeenCalledOnce());
    expect(openUrl).not.toHaveBeenCalled();
    expect(useAccountStore.getState()).toMatchObject({
      status: 'signed_out',
      error: 'cancelled',
    });
  });
});
