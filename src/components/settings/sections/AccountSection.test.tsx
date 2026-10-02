// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import type { ReactNode } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import AccountSection from './AccountSection';

// The enterprise build wraps the account card here; the marker shows what the page hands it.
vi.mock('@enterprise-modules/components/enterprise/EnterpriseAccountSlot', () => ({
  default: ({ children }: { children: ReactNode }) => <div data-testid="enterprise-account-slot">{children}</div>,
}));

const mocks = vi.hoisted(() => ({
  openAccountLogin: vi.fn(),
  hydrate: vi.fn(),
  signOut: vi.fn(),
  accountState: {} as Record<string, unknown>,
}));

vi.mock('@/core/account/accountStore', () => ({
  useAccountStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.accountState),
}));

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    openAccountLogin: mocks.openAccountLogin,
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

  it('keeps local use available and opens the shared login dialog', () => {
    render(<AccountSection />);
    expect(screen.getByText('不登录也能继续使用本地模型和自己的 API Key')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '登录 / 注册' }));
    expect(mocks.openAccountLogin).toHaveBeenCalledOnce();
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
    expect(screen.getByRole('button', { name: '退出登录' })).toHaveClass('bg-fill');
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('fills the one button of a signed-out page', () => {
    render(<AccountSection />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '登录 / 注册' })).toHaveClass('bg-emphasis');
  });

  it('keeps the page title outside the enterprise slot and the account card inside it', () => {
    render(<AccountSection />);
    const slot = screen.getByTestId('enterprise-account-slot');
    expect(slot).not.toContainElement(screen.getByRole('heading', { name: '账号' }));
    expect(slot).toContainElement(screen.getByRole('button', { name: '登录 / 注册' }));
    expect(slot.children).toHaveLength(1);
  });

  it('says the profile is loading with one spinner, next to what is already known', () => {
    mocks.accountState = {
      ...mocks.accountState,
      status: 'signed_in',
      profileStatus: 'loading',
      account: { serverUrl: 'https://accounts.example.com', userId: 'user-1', kind: 'personal', name: 'Ada', email: null },
    };
    render(<AccountSection />);
    expect(screen.getByRole('status')).toHaveTextContent('正在加载账号资料...');
    expect(document.querySelectorAll('[data-ds-spinner]')).toHaveLength(1);
    expect(screen.getByText('Ada')).toBeInTheDocument();
  });

  it('offers to load the profile again when it could not be read, and reads it once', () => {
    mocks.accountState = {
      ...mocks.accountState,
      status: 'signed_in',
      profileStatus: 'error',
      account: { serverUrl: 'https://accounts.example.com', userId: 'user-1', kind: 'personal', name: null, email: null },
    };
    render(<AccountSection />);
    const message = screen.getByRole('status');
    expect(message).toHaveTextContent('账号资料暂时无法加载。');
    expect(message).toHaveClass('bg-warning-soft');
    fireEvent.click(within(message).getByRole('button', { name: '重新加载' }));
    expect(mocks.hydrate).toHaveBeenCalledExactlyOnceWith();
    expect(document.querySelector('[data-ds-spinner]')).toBeNull();
    expect(screen.queryByRole('button', { name: '重新登录' })).toBeNull();
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

  it('says the sign-in has expired in an alert, fills only the sign-in button, and does not offer a reload', () => {
    mocks.accountState = {
      ...mocks.accountState,
      status: 'expired',
      profileStatus: 'error',
      account: { serverUrl: 'https://accounts.example.com', userId: 'user-1', kind: 'personal', name: null, email: null },
    };
    render(<AccountSection />);
    expect(screen.getByRole('alert')).toHaveTextContent('登录已过期，请重新登录。');
    expect(screen.queryByText('账号资料暂时无法加载。')).toBeNull();
    expect(screen.getByRole('button', { name: '重新登录' })).toHaveClass('bg-emphasis');
    expect(screen.getByRole('button', { name: '退出登录' })).not.toHaveClass('bg-emphasis');
    expect(mocks.hydrate).not.toHaveBeenCalled();
  });
});
