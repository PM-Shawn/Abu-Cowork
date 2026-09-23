// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import AccountLoginDialog from './AccountLoginDialog';

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  openSystemSettings: vi.fn(),
  startEnterpriseLogin: vi.fn(),
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

vi.mock('@/config/featureGates', () => ({ IS_ENTERPRISE_BUILD: true }));

vi.mock('@/core/enterprise/accountLogin', () => ({
  startEnterpriseAccountLogin: mocks.startEnterpriseLogin,
}));

describe('AccountLoginDialog', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    mocks.close.mockReset();
    mocks.start.mockReset();
    mocks.cancel.mockReset();
    mocks.signOut.mockReset();
    mocks.openSystemSettings.mockReset();
    mocks.startEnterpriseLogin.mockReset();
    mocks.startEnterpriseLogin.mockResolvedValue('started');
    mocks.uiState = {
      accountLoginOpen: true,
      closeAccountLogin: mocks.close,
      openSystemSettings: mocks.openSystemSettings,
    };
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

  it('starts enterprise browser login directly when the domain is configured', async () => {
    render(<AccountLoginDialog />);
    fireEvent.click(screen.getByRole('button', { name: '企业账号登录' }));

    await vi.waitFor(() => expect(mocks.startEnterpriseLogin).toHaveBeenCalledOnce());
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.openSystemSettings).not.toHaveBeenCalled();
  });

  it('opens enterprise settings when a domain still needs configuration', async () => {
    mocks.startEnterpriseLogin.mockResolvedValue('configuration_required');
    render(<AccountLoginDialog />);
    fireEvent.click(screen.getByRole('button', { name: '企业账号登录' }));

    await vi.waitFor(() => {
      expect(mocks.openSystemSettings).toHaveBeenCalledWith('enterprise');
    });
  });
});
