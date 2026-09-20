// @vitest-environment happy-dom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import AccountMenu from './AccountMenu';

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  account: {} as Record<string, unknown>,
  enterprise: {} as Record<string, unknown>,
  startEnterpriseLogin: vi.fn(),
}));

// 这一份覆盖个人登录开放之后的行为；关闭状态下的行为见 AccountMenu.personalGate.test.tsx。
vi.mock('@/config/featureGates', () => ({
  IS_ENTERPRISE_BUILD: true,
  IS_PERSONAL_ACCOUNT_ENABLED: true,
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
    mocks.enterprise.unbind = vi.fn();
    mocks.startEnterpriseLogin.mockReset();
    mocks.startEnterpriseLogin.mockResolvedValue('started');
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
    expect(screen.queryByText('切换账号')).not.toBeInTheDocument();
    expect(screen.getByText('退出企业账号')).toBeInTheDocument();
    expect(screen.queryByText('登录 / 注册')).not.toBeInTheDocument();
  });

  it('shows only enterprise actions while stale personal credentials are being cleaned up', () => {
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
      unbind: vi.fn(),
    };

    render(<AccountMenu onEditProfile={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Enterprise Admin/ }));

    expect(screen.getByText('admin@abu.local · Default Organization')).toBeInTheDocument();
    expect(screen.queryByText('Personal User')).not.toBeInTheDocument();
    expect(screen.queryByText('切换账号')).not.toBeInTheDocument();
    expect(screen.getByText('退出企业账号')).toBeInTheDocument();
    expect(screen.queryByText('账号设置')).not.toBeInTheDocument();
    expect(screen.queryByText('退出个人账号')).not.toBeInTheDocument();
  });

  it('keeps enterprise sign-out at the footer and profile editing in the identity header', () => {
    const editProfile = vi.fn();
    mocks.enterprise.mode = {
      kind: 'enterprise',
      binding: { userName: 'Admin', userEmail: 'admin@example.com', orgName: 'Example' },
    };
    render(<AccountMenu onEditProfile={editProfile} />);
    fireEvent.click(screen.getByRole('button', { name: /Admin/ }));
    const rows = screen.getAllByRole('menuitem');
    expect(rows.at(-1)).toHaveTextContent('退出企业账号');
    expect(rows.some(row => row.textContent?.includes('编辑资料'))).toBe(false);
    fireEvent.click(screen.getByTitle('编辑资料'));
    expect(editProfile).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: /Admin/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: '退出企业账号' }));
    expect(mocks.enterprise.unbind).toHaveBeenCalledOnce();
    expect(mocks.account.signOut).not.toHaveBeenCalled();
  });

  it('starts enterprise login from an active personal account', async () => {
    render(<AccountMenu onEditProfile={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '账号' }));
    fireEvent.click(screen.getByText('切换到企业账号'));

    expect(mocks.startEnterpriseLogin).toHaveBeenCalledOnce();
  });

  it('keeps the local identity head separate from the signed-out login action', () => {
    const onEditProfile = vi.fn();
    mocks.settings = { ...mocks.settings, userNickname: '' };
    mocks.account = {
      ...mocks.account,
      status: 'signed_out',
      account: null,
      profileStatus: 'idle',
    };

    render(<AccountMenu onEditProfile={onEditProfile} />);
    fireEvent.click(screen.getByRole('button', { name: '我' }));

    expect(screen.getAllByText('我')).toHaveLength(2);
    expect(screen.getByText('本地模式')).toBeInTheDocument();
    const menuItems = within(screen.getByRole('menu')).getAllByRole('menuitem');
    expect(menuItems.at(-1)).toHaveAccessibleName('登录');
    expect(screen.queryByRole('menuitem', { name: '编辑资料' })).toBeNull();

    const editProfile = screen.getByRole('button', { name: '编辑资料' });
    expect(editProfile).toHaveClass('group-hover:opacity-100', 'focus-visible:opacity-100');
    fireEvent.click(editProfile);
    expect(onEditProfile).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
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
    const signOut = screen.getByRole('menuitem', { name: '退出个人账号' });
    expect(menuItems.at(-1)).toBe(signOut);
    expect(menuItems.at(-2)).toHaveAccessibleName(/更新/);
    expect(signOut.previousElementSibling).toHaveClass('h-px');
  });
});
