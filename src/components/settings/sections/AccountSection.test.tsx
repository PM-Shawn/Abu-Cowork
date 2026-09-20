// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import AccountSection from './AccountSection';

const mocks = vi.hoisted(() => ({
  openAccountLogin: vi.fn(),
  openSystemSettings: vi.fn(),
  hydrate: vi.fn(),
  signOut: vi.fn(),
  startEnterpriseLogin: vi.fn(),
  accountState: {} as Record<string, unknown>,
}));

vi.mock('@/core/account/accountStore', () => ({
  useAccountStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.accountState),
}));

vi.mock('@/core/enterprise/accountLogin', () => ({
  startEnterpriseAccountLogin: mocks.startEnterpriseLogin,
}));

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    openAccountLogin: mocks.openAccountLogin,
    openSystemSettings: mocks.openSystemSettings,
  }),
}));

describe('AccountSection', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    mocks.openAccountLogin.mockReset();
    mocks.hydrate.mockReset();
    mocks.signOut.mockReset();
    mocks.accountState = {
      status: 'signed_out',
      account: null,
      profileStatus: 'idle',
      hydrate: mocks.hydrate,
      signOut: mocks.signOut,
    };
  });

  it('keeps local use available and starts enterprise login while personal accounts are off', () => {
    mocks.startEnterpriseLogin.mockResolvedValue('started');
    render(<AccountSection />);
    expect(screen.getByText('不登录也能继续使用本地模型和自己的 API Key')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '登录 / 注册' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '企业账号登录' }));
    expect(mocks.startEnterpriseLogin).toHaveBeenCalledOnce();
    expect(mocks.openAccountLogin).not.toHaveBeenCalled();
  });

  it('shows only authenticated profile fields', () => {
    mocks.accountState = {
      ...mocks.accountState,
      status: 'signed_in',
      profileStatus: 'ready',
      account: {
        serverUrl: 'https://accounts.example.com',
        userId: 'user-1',
        kind: 'personal',
        name: 'Ada',
        email: 'ada@example.com',
      },
    };
    render(<AccountSection />);
    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.queryByText('user-1')).toBeNull();
    expect(screen.getByRole('button', { name: '退出登录' })).toHaveAttribute('data-variant', 'subtle');
  });

  it('offers both recovery paths when the stored session has expired', () => {
    mocks.accountState = {
      ...mocks.accountState,
      status: 'expired',
      profileStatus: 'error',
      account: {
        serverUrl: 'https://accounts.example.com',
        userId: 'user-1',
        kind: 'personal',
        name: null,
        email: null,
      },
    };
    render(<AccountSection />);
    fireEvent.click(screen.getByRole('button', { name: '重新登录' }));
    expect(mocks.openAccountLogin).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }));
    expect(mocks.signOut).toHaveBeenCalledOnce();
  });
});
