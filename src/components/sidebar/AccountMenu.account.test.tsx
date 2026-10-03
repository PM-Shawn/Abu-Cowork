// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import AccountMenu from './AccountMenu';

function renderMenu(onEditProfile: () => void = () => {}) {
  return render(<AccountMenu onEditProfile={onEditProfile} />, { wrapper: DesignSystemProvider });
}

// Menu items that open a dialog run once the menu has gone, from Radix's focus-scope timer.
async function flushMenuClose() {
  await act(() => vi.runOnlyPendingTimersAsync());
}

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  account: {} as Record<string, unknown>,
  enterprise: {} as Record<string, unknown>,
  startEnterpriseLogin: vi.fn(),
}));

vi.mock('@/config/featureGates', () => ({ IS_ENTERPRISE_BUILD: true }));

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
  beforeAll(() => {
    // happy-dom lacks the pointer-capture and scroll APIs Radix menus call.
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.releasePointerCapture ??= () => {};
    Element.prototype.scrollIntoView ??= () => {};
  });
  afterEach(() => { vi.useRealTimers(); });

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
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
    renderMenu();
    expect(screen.getByRole('button', { name: '账号' })).toBeInTheDocument();
    expect(screen.queryByText('本地昵称')).toBeNull();
  });

  it('shows the enterprise identity when no personal account is signed in', async () => {
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

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderMenu();

    await user.click(screen.getByRole('button', { name: /Admin/ }));

    expect(screen.getByText('admin@abu.local · Default Organization')).toBeInTheDocument();
    expect(screen.queryByText('切换账号')).not.toBeInTheDocument();
    expect(screen.getByText('退出企业账号')).toBeInTheDocument();
    expect(screen.queryByText('登录 / 注册')).not.toBeInTheDocument();
  });

  it('shows only enterprise actions while stale personal credentials are being cleaned up', async () => {
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

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderMenu();
    await user.click(screen.getByRole('button', { name: /Enterprise Admin/ }));

    expect(screen.getByText('admin@abu.local · Default Organization')).toBeInTheDocument();
    expect(screen.queryByText('Personal User')).not.toBeInTheDocument();
    expect(screen.queryByText('切换账号')).not.toBeInTheDocument();
    expect(screen.getByText('退出企业账号')).toBeInTheDocument();
    expect(screen.queryByText('账号设置')).not.toBeInTheDocument();
    expect(screen.queryByText('退出个人账号')).not.toBeInTheDocument();
  });

  it('keeps enterprise sign-out at the footer and profile editing first, under the identity head', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const editProfile = vi.fn();
    mocks.enterprise.mode = {
      kind: 'enterprise',
      binding: { userName: 'Admin', userEmail: 'admin@example.com', orgName: 'Example' },
    };
    renderMenu(editProfile);
    await user.click(screen.getByRole('button', { name: /Admin/ }));
    const rows = screen.getAllByRole('menuitem');
    expect(rows.at(-1)).toHaveTextContent('退出企业账号');
    expect(rows[0]).toHaveAccessibleName('编辑资料');
    await user.click(rows[0]);
    await flushMenuClose();
    expect(editProfile).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: /Admin/ }));
    await user.click(screen.getByRole('menuitem', { name: '退出企业账号' }));
    expect(mocks.enterprise.unbind).toHaveBeenCalledOnce();
    expect(mocks.account.signOut).not.toHaveBeenCalled();
  });

  it('starts enterprise login from an active personal account once the menu has gone', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderMenu();
    await user.click(screen.getByRole('button', { name: '账号' }));
    await user.click(screen.getByRole('menuitem', { name: '切换到企业账号' }));
    await flushMenuClose();

    expect(screen.queryByRole('menu')).toBeNull();
    expect(mocks.startEnterpriseLogin).toHaveBeenCalledOnce();
  });

  // The settings window gives focus back to whatever had it when it opened, so the three
  // items that open it leave focus on the account button first.
  it.each([
    ['设置', undefined],
    ['账号设置', 'account'],
    ['反馈', 'feedback'],
  ])('opens settings from 「%s」 only after the menu has gone, with focus back on the account button', async (item, section) => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderMenu();
    const trigger = screen.getByRole('button', { name: '账号' });
    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: item }));
    await flushMenuClose();

    expect(screen.queryByRole('menu')).toBeNull();
    expect(mocks.settings.openSystemSettings).toHaveBeenCalledOnce();
    if (section) expect(mocks.settings.openSystemSettings).toHaveBeenCalledWith(section);
    else expect(mocks.settings.openSystemSettings).toHaveBeenCalledWith();
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps focus off the account button when the item opens a legacy dialog', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const editProfile = vi.fn();
    renderMenu(editProfile);
    const trigger = screen.getByRole('button', { name: '账号' });
    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: '编辑资料' }));
    await flushMenuClose();

    expect(editProfile).toHaveBeenCalledOnce();
    // The profile dialog takes no focus; Enter on the trigger behind it would reopen
    // this menu underneath, so focus stays on the page body.
    expect(trigger).not.toHaveFocus();
    expect(document.activeElement).toBe(document.body);
  });

  it('runs a chosen item once: closing the menu again with Escape does not repeat it', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderMenu();
    const trigger = screen.getByRole('button', { name: '账号' });
    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: '设置' }));
    await flushMenuClose();
    expect(mocks.settings.openSystemSettings).toHaveBeenCalledOnce();

    await user.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await flushMenuClose();

    expect(screen.queryByRole('menu')).toBeNull();
    expect(mocks.settings.openSystemSettings).toHaveBeenCalledOnce();
  });

  it('keeps the local identity head separate from the signed-out login action', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onEditProfile = vi.fn();
    mocks.settings = { ...mocks.settings, userNickname: '' };
    mocks.account = {
      ...mocks.account,
      status: 'signed_out',
      account: null,
      profileStatus: 'idle',
    };

    renderMenu(onEditProfile);
    await user.click(screen.getByRole('button', { name: '我' }));

    // The name shows on the trigger and in the menu head; the avatars' initials are pictures.
    expect(screen.getAllByText('我').filter((el) => el.getAttribute('role') !== 'img')).toHaveLength(2);
    expect(screen.getByText('本地模式')).toBeInTheDocument();
    const menuItems = within(screen.getByRole('menu')).getAllByRole('menuitem');
    expect(menuItems.at(-1)).toHaveAccessibleName('登录');
    // Profile editing is its own item, apart from sign-in.
    expect(menuItems[0]).toHaveAccessibleName('编辑资料');

    await user.click(menuItems[0]);
    await flushMenuClose();
    expect(onEditProfile).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('places sign-out last, after update, behind its own divider', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
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

    renderMenu();
    await user.click(screen.getByRole('button', { name: 'Ada' }));

    const menuItems = within(screen.getByRole('menu')).getAllByRole('menuitem');
    const signOut = screen.getByRole('menuitem', { name: '退出个人账号' });
    expect(menuItems.at(-1)).toBe(signOut);
    expect(menuItems.at(-2)).toHaveAccessibleName(/更新/);
    expect(signOut.previousElementSibling).toHaveClass('h-px');
  });
});
