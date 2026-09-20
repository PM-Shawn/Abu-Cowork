// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import AccountMenu from './AccountMenu';

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  account: {} as Record<string, unknown>,
  enterprise: {} as Record<string, unknown>,
  startEnterpriseLogin: vi.fn(),
  openAccountLogin: vi.fn(),
}));

// 这一版发出去的状态：个人登录关闭，企业构建里只剩企业登录。
vi.mock('@/config/featureGates', () => ({
  IS_ENTERPRISE_BUILD: true,
  IS_PERSONAL_ACCOUNT_ENABLED: false,
}));

vi.mock('@/core/enterprise/accountLogin', () => ({
  startEnterpriseAccountLogin: mocks.startEnterpriseLogin,
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

describe('AccountMenu 个人登录关闭时', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    mocks.openAccountLogin.mockReset();
    mocks.startEnterpriseLogin.mockReset();
    mocks.startEnterpriseLogin.mockResolvedValue('started');
    mocks.settings = {
      userAvatar: '',
      userNickname: '本地昵称',
      theme: 'light',
      setTheme: vi.fn(),
      language: 'zh-CN',
      setLanguage: vi.fn(),
      openSystemSettings: vi.fn(),
      openAccountLogin: mocks.openAccountLogin,
      updateInfo: null,
      updateChecking: false,
      updateDownloadProgress: null,
      updateInstalling: false,
      updaterUnsupported: false,
    };
    // 个人账号即使有残留凭据，也不应该被当成已登录。
    mocks.account = {
      status: 'signed_in',
      account: {
        serverUrl: 'https://accounts.example.com',
        userId: 'user-1',
        kind: 'personal',
        name: '张三',
        email: 'zhangsan@example.com',
      },
      profileStatus: 'ready',
      signOut: vi.fn(),
    };
    mocks.enterprise = { mode: { kind: 'personal' }, unbind: vi.fn() };
  });

  it('底部是企业账号登录，不再是「登录」', () => {
    render(<AccountMenu onEditProfile={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '本地昵称' }));
    expect(screen.getByRole('menuitem', { name: '企业账号登录' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: '登录' })).not.toBeInTheDocument();
  });

  it('点它直接开始企业登录，不打开登录弹窗', () => {
    render(<AccountMenu onEditProfile={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '本地昵称' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '企业账号登录' }));
    expect(mocks.startEnterpriseLogin).toHaveBeenCalledOnce();
    expect(mocks.openAccountLogin).not.toHaveBeenCalled();
  });

  it('残留的个人凭据不会显示成已登录身份', () => {
    render(<AccountMenu onEditProfile={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '本地昵称' }));
    expect(screen.queryByText('zhangsan@example.com')).toBeNull();
    expect(screen.queryByRole('menuitem', { name: '账号设置' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: '退出个人账号' })).not.toBeInTheDocument();
  });
});
