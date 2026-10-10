// @vitest-environment happy-dom
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
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

function renderDialog() {
  return render(<AccountLoginDialog />, { wrapper: DesignSystemProvider });
}

// The three ways out of the window.
const dismissals: [string, () => Promise<void>][] = [
  ['Escape', async () => { await userEvent.keyboard('{Escape}'); }],
  ['a press on the dimmed area', async () => { await userEvent.click(document.querySelector('.bg-scrim')!); }],
  ['the close button', async () => { await userEvent.click(screen.getByRole('button', { name: '关闭' })); }],
];

// happy-dom reports no animation, so Radix removes a closed layer at once. With this, a closed
// layer has an exit animation: it stays on the page, as it does in the app while it fades out.
function keepClosingLayers() {
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) => {
    const styles = real(element, pseudo);
    return new Proxy(styles, {
      get(target, prop) {
        if (prop === 'animationName') return element.getAttribute('data-state') === 'closed' ? 'exit' : 'enter';
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
}
const closingWindow = () => document.querySelector<HTMLElement>('[role="dialog"][data-state="closed"]');

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
    renderDialog();
    expect(screen.getByRole('dialog', { name: '登录 / 注册' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '个人账号登录' }));
    expect(mocks.start).toHaveBeenCalledOnce();
  });

  it('cancels an in-flight authorization when the dialog closes', () => {
    mocks.accountState.status = 'awaiting_browser';
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  describe.each(dismissals)('dismissed with %s', (_name, dismiss) => {
    it('cancels the sign-in that is waiting for the browser, then closes', async () => {
      mocks.accountState.status = 'awaiting_browser';
      renderDialog();
      await dismiss();
      expect(mocks.cancel).toHaveBeenCalledOnce();
      expect(mocks.close).toHaveBeenCalledOnce();
      expect(mocks.cancel.mock.invocationCallOrder[0]).toBeLessThan(mocks.close.mock.invocationCallOrder[0]);
    });

    it('cancels the sign-in that is being completed, then closes', async () => {
      mocks.accountState.status = 'exchanging';
      renderDialog();
      await dismiss();
      expect(mocks.cancel).toHaveBeenCalledOnce();
      expect(mocks.close).toHaveBeenCalledOnce();
    });

    it('cancels a personal sign-in that was asked for and has not reached the browser yet', async () => {
      renderDialog();
      fireEvent.click(screen.getByRole('button', { name: '个人账号登录' }));
      await dismiss();
      expect(mocks.cancel).toHaveBeenCalledOnce();
      expect(mocks.close).toHaveBeenCalledOnce();
    });

    it('only closes when no sign-in is under way', async () => {
      renderDialog();
      await dismiss();
      expect(mocks.cancel).not.toHaveBeenCalled();
      expect(mocks.close).toHaveBeenCalledOnce();
    });
  });

  it('shows no window once signed in, and closes itself', () => {
    mocks.accountState.status = 'signed_in';
    mocks.accountState.account = { userId: 'user-1', kind: 'personal', name: 'Ada', email: 'ada@example.com' };
    renderDialog();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it('shows no window while it is not asked for', () => {
    mocks.uiState.accountLoginOpen = false;
    renderDialog();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.close).not.toHaveBeenCalled();
  });

  describe('while the window fades out', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it('starts no sign-in and signs nobody out from its buttons', async () => {
      keepClosingLayers();
      mocks.accountState.status = 'expired';
      mocks.accountState.account = { userId: 'user-1', kind: 'personal', name: null, email: null };
      const view = renderDialog();
      mocks.uiState = { ...mocks.uiState, accountLoginOpen: false };
      view.rerender(<AccountLoginDialog />);
      const closing = closingWindow()!;
      expect(closing).toBeInTheDocument();

      fireEvent.click(within(closing).getByRole('button', { name: '重新登录' }));
      fireEvent.click(within(closing).getByRole('button', { name: '企业账号登录' }));
      fireEvent.click(within(closing).getByRole('button', { name: '退出登录' }));
      await Promise.resolve();

      expect(mocks.start).not.toHaveBeenCalled();
      expect(mocks.startEnterpriseLogin).not.toHaveBeenCalled();
      expect(mocks.signOut).not.toHaveBeenCalled();
      expect(mocks.close).not.toHaveBeenCalled();
      expect(mocks.cancel).not.toHaveBeenCalled();
    });

    it('cancels nothing from its Cancel button', () => {
      keepClosingLayers();
      mocks.accountState.status = 'awaiting_browser';
      const view = renderDialog();
      mocks.uiState = { ...mocks.uiState, accountLoginOpen: false };
      view.rerender(<AccountLoginDialog />);

      fireEvent.click(within(closingWindow()!).getByRole('button', { name: '取消' }));

      expect(mocks.cancel).not.toHaveBeenCalled();
    });

    it('keeps the sentence it was showing when the sign-in finishes, and offers no sign-in or sign-out', () => {
      keepClosingLayers();
      mocks.accountState.status = 'exchanging';
      const view = renderDialog();
      mocks.accountState = {
        ...mocks.accountState,
        status: 'signed_in',
        account: { userId: 'user-1', kind: 'personal', name: 'Ada', email: 'ada@example.com' },
      };
      view.rerender(<AccountLoginDialog />);
      const closing = closingWindow()!;

      expect(within(closing).getByText('正在完成登录...')).toBeInTheDocument();
      expect(within(closing).queryByRole('button', { name: '个人账号登录' })).toBeNull();
      expect(within(closing).queryByRole('button', { name: '退出登录' })).toBeNull();
      expect(mocks.close).toHaveBeenCalledOnce();
      expect(mocks.cancel).not.toHaveBeenCalled();
    });
  });

  it('starts enterprise browser login directly when the domain is configured', async () => {
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: '企业账号登录' }));

    await vi.waitFor(() => expect(mocks.startEnterpriseLogin).toHaveBeenCalledOnce());
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.openSystemSettings).not.toHaveBeenCalled();
  });

  it('opens enterprise settings when a domain still needs configuration', async () => {
    mocks.startEnterpriseLogin.mockResolvedValue('configuration_required');
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: '企业账号登录' }));

    await vi.waitFor(() => {
      expect(mocks.openSystemSettings).toHaveBeenCalledWith('enterprise');
    });
  });
});
