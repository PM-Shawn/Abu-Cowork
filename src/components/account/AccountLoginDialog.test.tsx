// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import AccountLoginDialog from './AccountLoginDialog';

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  start: vi.fn(),
  cancel: vi.fn(),
  signOut: vi.fn(),
  uiState: {} as Record<string, unknown>,
  accountState: {} as Record<string, unknown>,
}));

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.uiState),
}));

vi.mock('@/core/account/accountStore', () => ({
  useAccountStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.accountState),
}));

vi.mock('@/components/enterprise/BindToEnterpriseFlow', () => ({
  default: () => null,
}));

describe('AccountLoginDialog', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    mocks.close.mockReset();
    mocks.start.mockReset();
    mocks.cancel.mockReset();
    mocks.signOut.mockReset();
    mocks.uiState = { accountLoginOpen: true, closeAccountLogin: mocks.close };
    mocks.accountState = {
      status: 'signed_out',
      account: null,
      error: null,
      startPersonalLogin: mocks.start,
      cancel: mocks.cancel,
      signOut: mocks.signOut,
    };
  });

  it('connects the centered dialog to the personal login action', () => {
    render(<AccountLoginDialog />);
    expect(screen.getByRole('dialog', { name: '登录 / 注册' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '个人账号登录' }));
    expect(mocks.start).toHaveBeenCalledOnce();
  });

  it('cancels an in-flight authorization when the dialog closes', () => {
    mocks.accountState.status = 'awaiting_browser';
    render(<AccountLoginDialog />);
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
