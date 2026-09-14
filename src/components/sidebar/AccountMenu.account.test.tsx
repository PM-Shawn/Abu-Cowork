// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
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
});
