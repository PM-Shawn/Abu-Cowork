// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import AccountMenu from './AccountMenu';

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  account: {} as Record<string, unknown>,
  enterprise: {} as Record<string, unknown>,
}));

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.settings),
}));

vi.mock('@/core/account/accountStore', () => ({
  useAccountStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.account),
}));

vi.mock('@/stores/enterpriseStore', () => ({
  useEnterpriseStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.enterprise),
}));

describe('AccountMenu identity', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    mocks.settings = {
      userAvatar: '',
      userNickname: '本地昵称',
      theme: 'light',
      setTheme: vi.fn(),
      language: 'zh-CN',
      setLanguage: vi.fn(),
      openSystemSettings: vi.fn(),
      openAccountLogin: vi.fn(),
      updateInfo: null,
      updateChecking: false,
      updateDownloadProgress: null,
      updateInstalling: false,
      updaterUnsupported: false,
    };
    mocks.account = {
      status: 'signed_in',
      account: {
        serverUrl: 'https://accounts.example.com',
        userId: 'user-1',
        kind: 'personal',
        name: null,
        email: null,
      },
      profileStatus: 'error',
      signOut: vi.fn(),
    };
    mocks.enterprise = { mode: { kind: 'personal' } };
  });

  it('does not present the local nickname as authenticated identity when profile loading fails', () => {
    render(<AccountMenu onEditProfile={() => {}} />);
    expect(screen.getByRole('button', { name: '账号' })).toBeInTheDocument();
    expect(screen.queryByText('本地昵称')).toBeNull();
  });

  it('shows the enterprise identity when no personal account is signed in', () => {
    mocks.account = {
      status: 'signed_out',
      account: null,
      profileStatus: 'idle',
      signOut: vi.fn(),
    };
    mocks.enterprise = {
      mode: {
        kind: 'enterprise',
        binding: {
          userName: 'Admin',
          userEmail: 'admin@abu.local',
          orgName: 'Default Organization',
        },
        config: null,
      },
    };

    render(<AccountMenu onEditProfile={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: /Admin/ }));

    expect(screen.getByText('admin@abu.local · Default Organization')).toBeInTheDocument();
    expect(screen.getByText('个人账号登录')).toBeInTheDocument();
    expect(screen.queryByText('登录 / 注册')).not.toBeInTheDocument();
  });

  it('keeps the active enterprise identity primary when a personal account also exists', () => {
    mocks.account = {
      status: 'signed_in',
      account: {
        serverUrl: 'https://accounts.example.com',
        userId: 'personal-user',
        kind: 'personal',
        name: 'Personal User',
        email: 'personal@example.com',
      },
      profileStatus: 'ready',
      signOut: vi.fn(),
    };
    mocks.enterprise = {
      mode: {
        kind: 'enterprise',
        binding: {
          userName: 'Enterprise Admin',
          userEmail: 'admin@abu.local',
          orgName: 'Default Organization',
        },
        config: null,
      },
    };

    render(<AccountMenu onEditProfile={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Enterprise Admin/ }));

    expect(screen.getByText('admin@abu.local · Default Organization')).toBeInTheDocument();
    expect(screen.queryByText('Personal User')).not.toBeInTheDocument();
    expect(screen.getByText('个人账号设置')).toBeInTheDocument();
    expect(screen.getByText('退出个人账号')).toBeInTheDocument();
  });
});
