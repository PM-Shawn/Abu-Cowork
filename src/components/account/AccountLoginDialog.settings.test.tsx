// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { useSyncExternalStore } from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CommandConfirmDialog from '@/components/common/CommandConfirmDialog';
import {
  drainConfirmationQueue,
  getPendingCommandConfirmation,
  requestCommandConfirmationForConversation,
  resolveCommandConfirmation,
  subscribeToCommandConfirmation,
} from '@/core/agent/permissionBridge';
import { useChatStore } from '@/stores/chatStore';
import { Button } from '@/components/ds/button';
import { Dialog } from '@/components/ds/dialog';
import { DesignSystemProvider } from '@/components/ds/provider';
import SystemSettingsDialog from '@/components/settings/SystemSettingsDialog';
import { __resetAccountStoreForTest, useAccountStore } from '@/core/account/accountStore';
import { initLanguage } from '@/i18n';
import { usePreviewStore } from '@/stores/previewStore';
import { useSettingsStore } from '@/stores/settingsStore';
import AccountLoginDialog from './AccountLoginDialog';

// The sign-in window with the real settings store and the real settings window around it.
// The settings pages are replaced by the one button the account page has for signing in.
vi.mock('@/components/settings/SystemSettingsModal', async () => {
  const { Button } = await import('@/components/ds/button');
  const { useSettingsStore: store } = await import('@/stores/settingsStore');
  return {
    default: () => <Button onClick={() => store.getState().openAccountLogin()}>Sign in from the account page</Button>,
  };
});

const settingsWindow = () => document.querySelector('[data-abu-settings-dialog]');

describe('AccountLoginDialog opened from the settings window', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    __resetAccountStoreForTest();
    usePreviewStore.setState({ appModalOpen: false });
    useSettingsStore.setState({ systemSettingsOpen: true, accountLoginOpen: false });
  });
  afterEach(() => {
    useSettingsStore.setState({ systemSettingsOpen: false, accountLoginOpen: false });
  });

  it('closes the settings window and stands alone', async () => {
    const user = userEvent.setup();
    render(<><SystemSettingsDialog /><AccountLoginDialog /></>, { wrapper: DesignSystemProvider });
    expect(settingsWindow()).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Sign in from the account page' }));

    expect(useSettingsStore.getState().systemSettingsOpen).toBe(false);
    expect(useSettingsStore.getState().accountLoginOpen).toBe(true);
    expect(settingsWindow()).toBeNull();
    const dialogs = screen.getAllByRole('dialog');
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]).toHaveAccessibleName('登录 / 注册');
  });

  it('carries the markers the window is found by on the window and on its close button', async () => {
    const user = userEvent.setup();
    render(<><SystemSettingsDialog /><AccountLoginDialog /></>, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Sign in from the account page' }));

    const dialog = screen.getByRole('dialog', { name: '登录 / 注册' });
    expect(dialog).toHaveAttribute('data-abu-account-dialog');
    expect(dialog).toHaveAttribute('data-electron-no-drag');
    const close = document.querySelector('[data-abu-account-dialog-close]');
    expect(dialog).toContainElement(close as HTMLElement);
    expect(close).toHaveAccessibleName('关闭');
  });

  // The close-window question and the approvals of the task in view are still drawn by the old
  // modals. A design-system dialog would leave them unable to take a press.
  describe('while an old blocking prompt is on screen', () => {
    const cancel = vi.fn();
    beforeEach(() => {
      cancel.mockReset();
      useSettingsStore.setState({ systemSettingsOpen: false, accountLoginOpen: true });
      useAccountStore.setState({ status: 'awaiting_browser', cancel });
    });
    afterEach(() => { usePreviewStore.setState({ appModalOpen: false }); });

    it('leaves the page without cancelling the sign-in, and comes back when the prompt has gone', () => {
      render(<AccountLoginDialog />, { wrapper: DesignSystemProvider });
      expect(screen.getByRole('dialog', { name: '登录 / 注册' })).toHaveTextContent('请在浏览器中完成登录');

      act(() => { usePreviewStore.setState({ appModalOpen: true }); });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(cancel).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().accountLoginOpen).toBe(true);
      expect(useAccountStore.getState().status).toBe('awaiting_browser');

      act(() => { usePreviewStore.setState({ appModalOpen: false }); });
      expect(screen.getByRole('dialog', { name: '登录 / 注册' })).toHaveTextContent('请在浏览器中完成登录');
      expect(cancel).not.toHaveBeenCalled();
    });

    it('leaves and comes back the same way while the sign-in is being completed', () => {
      useAccountStore.setState({ status: 'exchanging' });
      render(<AccountLoginDialog />, { wrapper: DesignSystemProvider });
      expect(screen.getByRole('dialog', { name: '登录 / 注册' })).toBeInTheDocument();

      act(() => { usePreviewStore.setState({ appModalOpen: true }); });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(cancel).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().accountLoginOpen).toBe(true);
      expect(useAccountStore.getState().status).toBe('exchanging');

      act(() => { usePreviewStore.setState({ appModalOpen: false }); });
      expect(screen.getByRole('dialog', { name: '登录 / 注册' })).toBeInTheDocument();
      expect(cancel).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().accountLoginOpen).toBe(true);
    });

    it('leaves and comes back the same way after a personal sign-in was asked for and has not reached the browser', async () => {
      // The sign-in was asked for and its first step has not answered: the status has not moved yet.
      const startPersonalLogin = vi.fn(() => new Promise<string | null>(() => undefined));
      useAccountStore.setState({ status: 'signed_out', startPersonalLogin });
      render(<AccountLoginDialog />, { wrapper: DesignSystemProvider });
      await userEvent.setup().click(screen.getByRole('button', { name: '个人账号登录' }));
      expect(startPersonalLogin).toHaveBeenCalledTimes(1);

      act(() => { usePreviewStore.setState({ appModalOpen: true }); });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(cancel).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().accountLoginOpen).toBe(true);

      act(() => { usePreviewStore.setState({ appModalOpen: false }); });
      expect(screen.getByRole('dialog', { name: '登录 / 注册' })).toBeInTheDocument();
      expect(cancel).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().accountLoginOpen).toBe(true);
      // Still the same sign-in: closing the window now cancels it.
      await userEvent.setup().keyboard('{Escape}');
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(useSettingsStore.getState().accountLoginOpen).toBe(false);
    });

    it('does not appear when it is asked for while the prompt is up, and appears afterwards', () => {
      usePreviewStore.setState({ appModalOpen: true });
      render(<AccountLoginDialog />, { wrapper: DesignSystemProvider });
      expect(screen.queryByRole('dialog')).toBeNull();

      act(() => { usePreviewStore.setState({ appModalOpen: false }); });
      expect(screen.getByRole('dialog', { name: '登录 / 注册' })).toBeInTheDocument();
      expect(cancel).not.toHaveBeenCalled();
    });

    it('still closes itself when the sign-in finishes behind the prompt', () => {
      render(<AccountLoginDialog />, { wrapper: DesignSystemProvider });
      act(() => { usePreviewStore.setState({ appModalOpen: true }); });
      act(() => {
        useAccountStore.setState({ status: 'signed_in', account: { serverUrl: 'https://accounts.example.com', userId: 'user-1', kind: 'personal', name: 'Ada', email: null } });
      });
      expect(useSettingsStore.getState().accountLoginOpen).toBe(false);
      act(() => { usePreviewStore.setState({ appModalOpen: false }); });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(cancel).not.toHaveBeenCalled();
    });
  });

  // An approval is a design-system layer of its own kind. A sign-in that is under way is work in
  // progress: the window steps aside for the approval and returns; nothing is cancelled.
  describe('when an approval arrives', () => {
    const cancel = vi.fn();
    const onApprovalAnswer = vi.fn();
    function Page({ approval }: { approval: boolean }) {
      return (
        <DesignSystemProvider>
          <AccountLoginDialog />
          <Dialog
            open={approval}
            onOpenChange={onApprovalAnswer}
            layer="approval"
            role="alertdialog"
            outsidePress="ignore"
            title="Confirm Action"
            footer={<Button>Cancel the command</Button>}
          />
        </DesignSystemProvider>
      );
    }
    const loginWindow = () => document.querySelector<HTMLElement>('[data-abu-account-dialog]');

    beforeEach(() => {
      cancel.mockReset();
      onApprovalAnswer.mockReset();
      useSettingsStore.setState({ systemSettingsOpen: false, accountLoginOpen: true });
      useAccountStore.setState({ status: 'signed_out', cancel });
    });

    async function expectStepsAsideAndReturns(status: 'signed_out' | 'awaiting_browser' | 'exchanging') {
      const view = render(<Page approval={false} />);
      const window = loginWindow();
      expect(window).not.toBeNull();

      view.rerender(<Page approval />);
      expect(screen.getByRole('alertdialog', { name: 'Confirm Action' })).toBeInTheDocument();
      // Still in the page, hidden: not on screen and not in the accessibility tree.
      expect(loginWindow()).toBe(window);
      expect(window).toHaveAttribute('hidden');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(cancel).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().accountLoginOpen).toBe(true);
      expect(useAccountStore.getState().status).toBe(status);

      // The keyboard acts on the approval alone.
      await userEvent.setup().keyboard('{Escape}');
      expect(onApprovalAnswer.mock.calls).toEqual([[false]]);
      expect(cancel).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().accountLoginOpen).toBe(true);

      view.rerender(<Page approval={false} />);
      expect(loginWindow()).toBe(window);
      expect(window).not.toHaveAttribute('hidden');
      expect(screen.getByRole('dialog', { name: '登录 / 注册' })).toBe(window);
      expect(cancel).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().accountLoginOpen).toBe(true);
      expect(useAccountStore.getState().status).toBe(status);
    }

    it.each(['awaiting_browser', 'exchanging'] as const)('steps aside without cancelling a sign-in that is %s, and returns', async (status) => {
      useAccountStore.setState({ status });
      await expectStepsAsideAndReturns(status);
    });

    it('steps aside without cancelling a personal sign-in that was asked for and has not reached the browser, and returns', async () => {
      const startPersonalLogin = vi.fn(() => new Promise<string | null>(() => undefined));
      useAccountStore.setState({ startPersonalLogin });
      const view = render(<Page approval={false} />);
      const window = loginWindow();
      await userEvent.setup().click(screen.getByRole('button', { name: '个人账号登录' }));
      expect(startPersonalLogin).toHaveBeenCalledTimes(1);
      expect(useAccountStore.getState().status).toBe('signed_out');

      view.rerender(<Page approval />);
      expect(loginWindow()).toBe(window);
      expect(window).toHaveAttribute('hidden');
      expect(cancel).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().accountLoginOpen).toBe(true);

      view.rerender(<Page approval={false} />);
      expect(loginWindow()).toBe(window);
      expect(window).not.toHaveAttribute('hidden');
      expect(cancel).not.toHaveBeenCalled();
      // Still the same sign-in: closing the window now cancels it.
      await userEvent.setup().keyboard('{Escape}');
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(useSettingsStore.getState().accountLoginOpen).toBe(false);
    });

    it('closes for the approval when no sign-in is under way, cancels nothing, and does not come back by itself', () => {
      const view = render(<Page approval={false} />);
      expect(screen.getByRole('dialog', { name: '登录 / 注册' })).toBeInTheDocument();

      view.rerender(<Page approval />);
      expect(useSettingsStore.getState().accountLoginOpen).toBe(false);
      expect(cancel).not.toHaveBeenCalled();
      expect(onApprovalAnswer).not.toHaveBeenCalled();

      view.rerender(<Page approval={false} />);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(useSettingsStore.getState().accountLoginOpen).toBe(false);
    });

    it('is turned away when it is opened while an approval is on screen, and the approval is not answered', () => {
      useSettingsStore.setState({ accountLoginOpen: false });
      render(<Page approval />);
      act(() => { useSettingsStore.getState().openAccountLogin(); });

      expect(useSettingsStore.getState().accountLoginOpen).toBe(false);
      expect(loginWindow()).toBeNull();
      expect(cancel).not.toHaveBeenCalled();
      expect(onApprovalAnswer).not.toHaveBeenCalled();
    });

    // Until the close-window question is a design-system layer the window also leaves the page
    // for it by itself. The two ways of leaving do not cancel the sign-in between them.
    it.each(['awaiting_browser', 'exchanging'] as const)('keeps a sign-in that is %s when the close-window question comes and goes while it stands aside', (status) => {
      useAccountStore.setState({ status });
      const view = render(<Page approval={false} />);
      view.rerender(<Page approval />);
      act(() => { usePreviewStore.setState({ appModalOpen: true }); });
      expect(loginWindow()).toBeNull();
      expect(cancel).not.toHaveBeenCalled();

      // The approval is answered first, then the question is cancelled.
      view.rerender(<Page approval={false} />);
      act(() => { usePreviewStore.setState({ appModalOpen: false }); });
      expect(screen.getByRole('dialog', { name: '登录 / 注册' })).toBeInTheDocument();
      expect(cancel).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().accountLoginOpen).toBe(true);
      expect(useAccountStore.getState().status).toBe(status);
      expect(onApprovalAnswer).not.toHaveBeenCalled();
    });
  });

  // The command approval of the task in view, asked through the real approval queue and drawn
  // the way the chat view draws it. The window's own way of leaving for an old prompt sees this
  // approval too; with both at work the sign-in still goes on.
  describe('when the command approval of the task in view arrives', () => {
    const cancel = vi.fn();
    function ChatApprovals() {
      const pending = useSyncExternalStore(subscribeToCommandConfirmation, getPendingCommandConfirmation);
      const inView = useChatStore((state) => state.activeConversationId);
      if (!pending || pending.conversationId !== inView) return null;
      return (
        <CommandConfirmDialog
          key={pending.id}
          request={pending.info}
          onConfirm={() => resolveCommandConfirmation(true)}
          onCancel={() => resolveCommandConfirmation(false)}
        />
      );
    }
    const loginWindow = () => document.querySelector<HTMLElement>('[data-abu-account-dialog]');
    const shownLoginWindow = () => {
      const window = loginWindow();
      return window && !window.hasAttribute('hidden') ? window : null;
    };

    beforeEach(() => {
      cancel.mockReset();
      useChatStore.setState({ activeConversationId: 'conversation-in-view' });
      useSettingsStore.setState({ systemSettingsOpen: false, accountLoginOpen: true, viewMode: 'chat' });
      useAccountStore.setState({ status: 'signed_out', cancel });
    });
    afterEach(() => {
      act(() => { drainConfirmationQueue(); });
      useChatStore.setState({ activeConversationId: null });
    });

    function askCommand() {
      const answers: boolean[] = [];
      act(() => {
        void requestCommandConfirmationForConversation(
          { command: 'echo not-a-real-command', level: 'warn', reason: 'needs a look' },
          'conversation-in-view',
        ).then((answer) => { answers.push(answer); });
      });
      return answers;
    }

    it.each(['awaiting_browser', 'exchanging'] as const)('goes on with a sign-in that is %s while the approval is asked and answered', async (status) => {
      useAccountStore.setState({ status });
      render(<><ChatApprovals /><AccountLoginDialog /></>, { wrapper: DesignSystemProvider });
      expect(shownLoginWindow()).not.toBeNull();

      const answers = askCommand();
      expect(screen.getByRole('alertdialog', { name: '操作确认' })).toBeInTheDocument();
      expect(shownLoginWindow()).toBeNull();
      expect(cancel).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().accountLoginOpen).toBe(true);
      expect(answers).toEqual([]);

      await userEvent.setup().click(screen.getByRole('button', { name: '取消' }));
      await act(async () => { await Promise.resolve(); });
      expect(answers).toEqual([false]);
      expect(shownLoginWindow()).not.toBeNull();
      expect(screen.getByRole('dialog', { name: '登录 / 注册' })).toBeInTheDocument();
      expect(cancel).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().accountLoginOpen).toBe(true);
      expect(useAccountStore.getState().status).toBe(status);
    });

    it('goes on with a personal sign-in that was asked for while the approval is asked and answered', async () => {
      const user = userEvent.setup();
      const startPersonalLogin = vi.fn(() => new Promise<string | null>(() => undefined));
      useAccountStore.setState({ startPersonalLogin });
      render(<><ChatApprovals /><AccountLoginDialog /></>, { wrapper: DesignSystemProvider });
      await user.click(screen.getByRole('button', { name: '个人账号登录' }));

      const answers = askCommand();
      expect(shownLoginWindow()).toBeNull();
      expect(cancel).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: '确认执行' }));
      await act(async () => { await Promise.resolve(); });
      expect(answers).toEqual([true]);
      expect(shownLoginWindow()).not.toBeNull();
      expect(cancel).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().accountLoginOpen).toBe(true);
      // Still the same sign-in: closing the window now cancels it.
      await user.keyboard('{Escape}');
      expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('does not answer the approval when the sign-in finishes behind it', async () => {
      useAccountStore.setState({ status: 'awaiting_browser' });
      render(<><ChatApprovals /><AccountLoginDialog /></>, { wrapper: DesignSystemProvider });
      const answers = askCommand();

      act(() => {
        useAccountStore.setState({ status: 'signed_in', account: { serverUrl: 'https://accounts.example.invalid', userId: 'user-1', kind: 'personal', name: 'Ada', email: null } });
      });
      await act(async () => { await Promise.resolve(); });
      expect(useSettingsStore.getState().accountLoginOpen).toBe(false);
      expect(answers).toEqual([]);
      expect(screen.getByRole('alertdialog', { name: '操作确认' })).toBeInTheDocument();
      expect(cancel).not.toHaveBeenCalled();
    });
  });

  it('can be used once it is open: its buttons take the press and Escape closes only it', async () => {
    const user = userEvent.setup();
    render(<><SystemSettingsDialog /><AccountLoginDialog /></>, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Sign in from the account page' }));

    const dialog = screen.getByRole('dialog', { name: '登录 / 注册' });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard('{Escape}');
    expect(useSettingsStore.getState().accountLoginOpen).toBe(false);
    expect(useSettingsStore.getState().systemSettingsOpen).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
