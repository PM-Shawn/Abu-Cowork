// @vitest-environment happy-dom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import AccountMenu from './AccountMenu';

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  account: {} as Record<string, unknown>,
}));

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.settings),
}));

vi.mock('@/core/account/accountStore', () => ({
  useAccountStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.account),
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
  });

  it('does not present the local nickname as authenticated identity when profile loading fails', () => {
    render(<AccountMenu onEditProfile={() => {}} />);
    expect(screen.getByRole('button', { name: '账号' })).toBeInTheDocument();
    expect(screen.queryByText('本地昵称')).toBeNull();
  });

  it('keeps the local identity head separate from the signed-out login action', () => {
    mocks.settings = { ...mocks.settings, userNickname: '' };
    mocks.account = {
      ...mocks.account,
      status: 'signed_out',
      account: null,
      profileStatus: 'idle',
    };

    render(<AccountMenu onEditProfile={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '我' }));

    expect(screen.getAllByText('我')).toHaveLength(2);
    expect(screen.getByText('本地模式')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '登录 / 注册' })).toBeInTheDocument();
  });

  it('places sign-out last, after update, behind its own divider', () => {
    mocks.account = {
      ...mocks.account,
      account: {
        serverUrl: 'https://accounts.example.com',
        userId: 'user-1',
        kind: 'personal',
        name: 'Ada',
        email: 'ada@example.com',
      },
      profileStatus: 'ready',
    };

    render(<AccountMenu onEditProfile={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ada' }));

    const menuItems = within(screen.getByRole('menu')).getAllByRole('menuitem');
    const signOut = screen.getByRole('menuitem', { name: '退出登录' });
    expect(menuItems.at(-1)).toBe(signOut);
    expect(menuItems.at(-2)).toHaveAccessibleName(/更新/);
    expect(signOut.previousElementSibling).toHaveClass('h-px');
  });
});
