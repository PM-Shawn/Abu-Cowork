// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { useSyncExternalStore } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CloseDialog from '@/components/common/CloseDialog';
import CommandConfirmDialog from '@/components/common/CommandConfirmDialog';
import PermissionDialog from '@/components/common/PermissionDialog';
import {
  drainConfirmationQueue,
  drainFilePermissionQueue,
  drainWorkspaceRequest,
  getPendingCommandConfirmation,
  getPendingFilePermission,
  getPendingWorkspaceRequest,
  requestCommandConfirmationForConversation,
  requestWorkspace,
  resolveCommandConfirmation,
  resolveFilePermission,
  resolveWorkspaceRequest,
  subscribeToCommandConfirmation,
  subscribeToFilePermission,
  subscribeToWorkspaceRequest,
} from '@/core/agent/permissionBridge';
import * as approvalBridge from '@/core/agent/ports/approvalBridge';
import { useChatStore } from '@/stores/chatStore';
import { usePermissionStore } from '@/stores/permissionStore';
import { Button } from '@/components/ds/button';
import { Dialog } from '@/components/ds/dialog';
import { DesignSystemProvider } from '@/components/ds/provider';
import SystemSettingsDialog from '@/components/settings/SystemSettingsDialog';
import { __resetAccountStoreForTest, useAccountStore } from '@/core/account/accountStore';
import { initLanguage } from '@/i18n';
import { usePreviewStore } from '@/stores/previewStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { passSettleInterval } from '@/test/dsWindows';
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

  // The close-window question is a question about what is on screen: it stacks over the sign-in
  // window, which stays where it is with its sign-in going on.
  describe('while the close-window question is asked', () => {
    const cancel = vi.fn();
    const onQuestionCancel = vi.fn();
    const onQuit = vi.fn();
    function CloseQuestion() {
      const open = usePreviewStore((s) => s.appModalOpen);
      return (
        <CloseDialog
          open={open}
          hasRunningAgent={false}
          onQuit={onQuit}
          onMinimize={() => undefined}
          onCancel={() => {
            usePreviewStore.getState().setAppModalOpen(false);
            onQuestionCancel();
          }}
          onCloseActionChange={() => undefined}
        />
      );
    }
    const renderBoth = () => render(<><AccountLoginDialog /><CloseQuestion /></>, { wrapper: DesignSystemProvider });
    const loginWindow = () => document.querySelector<HTMLElement>('[data-abu-account-dialog]');
    const question = () => screen.queryByRole('alertdialog', { name: '关闭窗口' });

    beforeEach(() => {
      cancel.mockReset();
      onQuestionCancel.mockReset();
      onQuit.mockReset();
      useSettingsStore.setState({ systemSettingsOpen: false, accountLoginOpen: true });
      useAccountStore.setState({ status: 'awaiting_browser', cancel });
    });
    afterEach(() => { usePreviewStore.setState({ appModalOpen: false }); });

    it.each(['awaiting_browser', 'exchanging'] as const)('stays on the page under the question with a sign-in that is %s, and nothing is cancelled when the question is', async (status) => {
      useAccountStore.setState({ status });
      renderBoth();
      const window = loginWindow();
      expect(window).not.toBeNull();

      act(() => { usePreviewStore.setState({ appModalOpen: true }); });
      expect(question()).toBeInTheDocument();
      expect(loginWindow()).toBe(window);
      expect(window).not.toHaveAttribute('hidden');
      expect(window).toHaveAttribute('data-state', 'open');
      expect(cancel).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().accountLoginOpen).toBe(true);
      expect(useAccountStore.getState().status).toBe(status);

      // One Escape closes the question alone.
      await userEvent.setup().keyboard('{Escape}');
      expect(onQuestionCancel).toHaveBeenCalledTimes(1);
      expect(question()).toBeNull();
      expect(screen.getByRole('dialog', { name: '登录 / 注册' })).toBe(window);
      expect(cancel).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().accountLoginOpen).toBe(true);
      expect(useAccountStore.getState().status).toBe(status);
      expect(onQuit).not.toHaveBeenCalled();
    });

    it('keeps a personal sign-in that was asked for through the question, and closing the window afterwards still cancels it', async () => {
      const user = userEvent.setup();
      // The sign-in was asked for and its first step has not answered: the status has not moved yet.
      const startPersonalLogin = vi.fn(() => new Promise<string | null>(() => undefined));
      useAccountStore.setState({ status: 'signed_out', startPersonalLogin });
      renderBoth();
      await user.click(screen.getByRole('button', { name: '个人账号登录' }));
      expect(startPersonalLogin).toHaveBeenCalledTimes(1);

      act(() => { usePreviewStore.setState({ appModalOpen: true }); });
      await user.keyboard('{Escape}');
      expect(onQuestionCancel).toHaveBeenCalledTimes(1);
      expect(cancel).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().accountLoginOpen).toBe(true);

      // Still the same sign-in: closing the window now cancels it.
      await user.keyboard('{Escape}');
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(useSettingsStore.getState().accountLoginOpen).toBe(false);
    });

    // A window that opens is a new thing on screen: the question about the old one is dropped.
    it('cancels the question, without quitting, when the window is opened while the question is up', () => {
      useSettingsStore.setState({ accountLoginOpen: false });
      useAccountStore.setState({ status: 'signed_out' });
      usePreviewStore.setState({ appModalOpen: true });
      renderBoth();
      expect(question()).toBeInTheDocument();

      act(() => { useSettingsStore.getState().openAccountLogin(); });
      expect(screen.getByRole('dialog', { name: '登录 / 注册' })).toBeInTheDocument();
      expect(onQuestionCancel).toHaveBeenCalledTimes(1);
      expect(usePreviewStore.getState().appModalOpen).toBe(false);
      expect(onQuit).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
    });

    // The question belongs to the window it was asked over and ends with it.
    it('closes itself when the sign-in finishes under the question; the question is cancelled, never answered', () => {
      renderBoth();
      act(() => { usePreviewStore.setState({ appModalOpen: true }); });
      act(() => {
        useAccountStore.setState({ status: 'signed_in', account: { serverUrl: 'https://accounts.example.invalid', userId: 'user-1', kind: 'personal', name: 'Ada', email: null } });
      });
      expect(useSettingsStore.getState().accountLoginOpen).toBe(false);
      expect(onQuestionCancel).toHaveBeenCalledTimes(1);
      expect(usePreviewStore.getState().appModalOpen).toBe(false);
      expect(onQuit).not.toHaveBeenCalled();
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

    // While it stands aside for one approval (the task's grant window), other requests of the
    // task in view come and go in their queues. The window watches none of them: it stays aside,
    // the sign-in goes on, and it returns when the approval on screen has been answered.
    describe('and other requests of the task in view come and go while it stands aside', () => {
      beforeEach(() => {
        useChatStore.setState({ activeConversationId: 'conversation-in-view' });
        useSettingsStore.setState({ viewMode: 'chat' });
      });
      afterEach(() => {
        act(() => { drainWorkspaceRequest(); drainConfirmationQueue(); });
        useChatStore.setState({ activeConversationId: null });
        vi.useRealTimers();
      });

      function expectStillSigningIn(status: 'awaiting_browser' | 'exchanging') {
        expect(cancel).not.toHaveBeenCalled();
        expect(useSettingsStore.getState().accountLoginOpen).toBe(true);
        expect(useAccountStore.getState().status).toBe(status);
        expect(onApprovalAnswer).not.toHaveBeenCalled();
      }
      function expectBackAfterTheApproval(view: ReturnType<typeof render>, status: 'awaiting_browser' | 'exchanging') {
        expect(screen.queryByRole('dialog')).toBeNull();
        view.rerender(<Page approval={false} />);
        expect(screen.getByRole('dialog', { name: '登录 / 注册' })).toBeInTheDocument();
        expect(loginWindow()).not.toHaveAttribute('hidden');
        expectStillSigningIn(status);
      }

      it.each(['awaiting_browser', 'exchanging'] as const)('keeps a sign-in that is %s when a workspace request times out under the approval', (status) => {
        vi.useFakeTimers();
        useAccountStore.setState({ status });
        const view = render(<Page approval={false} />);
        view.rerender(<Page approval />);
        expect(loginWindow()).toHaveAttribute('hidden');

        const window = loginWindow();
        const answers: (string | null)[] = [];
        act(() => { void requestWorkspace('needs a folder', 'conversation-in-view', '/fake/project').then((answer) => { answers.push(answer); }); });
        expect(loginWindow()).toBe(window);
        expect(window).toHaveAttribute('hidden');
        expectStillSigningIn(status);

        // Nobody answers the workspace request: it answers itself after 60 seconds.
        act(() => { vi.advanceTimersByTime(60_000); });
        expect(getPendingWorkspaceRequest()).toBeNull();
        expect(loginWindow()).toBe(window);
        expect(window).toHaveAttribute('hidden');
        expectStillSigningIn(status);
        expectBackAfterTheApproval(view, status);
        expect(loginWindow()).toBe(window);
      });

      it.each(['awaiting_browser', 'exchanging'] as const)('keeps a sign-in that is %s when the conversation in view changes under the approval', (status) => {
        useAccountStore.setState({ status });
        const view = render(<Page approval={false} />);
        view.rerender(<Page approval />);
        const window = loginWindow();
        act(() => {
          void requestCommandConfirmationForConversation({ command: 'echo not-a-real-command', level: 'warn', reason: 'needs a look' }, 'conversation-in-view');
        });
        expect(loginWindow()).toBe(window);
        expect(window).toHaveAttribute('hidden');
        expectStillSigningIn(status);

        act(() => { useChatStore.setState({ activeConversationId: 'another-conversation' }); });
        expect(loginWindow()).toBe(window);
        expect(window).toHaveAttribute('hidden');
        expectStillSigningIn(status);
        expectBackAfterTheApproval(view, status);
        expect(loginWindow()).toBe(window);
      });

      it('keeps a personal sign-in that was asked for when the conversation in view changes under the approval', async () => {
        const startPersonalLogin = vi.fn(() => new Promise<string | null>(() => undefined));
        useAccountStore.setState({ startPersonalLogin });
        const view = render(<Page approval={false} />);
        await userEvent.setup().click(screen.getByRole('button', { name: '个人账号登录' }));
        view.rerender(<Page approval />);
        act(() => {
          void requestCommandConfirmationForConversation({ command: 'echo not-a-real-command', level: 'warn', reason: 'needs a look' }, 'conversation-in-view');
        });
        act(() => { useChatStore.setState({ activeConversationId: 'another-conversation' }); });

        expect(cancel).not.toHaveBeenCalled();
        expect(useSettingsStore.getState().accountLoginOpen).toBe(true);
        view.rerender(<Page approval={false} />);
        expect(screen.getByRole('dialog', { name: '登录 / 注册' })).toBeInTheDocument();
        expect(cancel).not.toHaveBeenCalled();
      });
    });

    // The close-window question asked while the window stands aside stacks over the approval.
    // It is cancelled when the approval is answered elsewhere; the sign-in window then returns.
    describe('and the close-window question is asked while it stands aside', () => {
      const onQuestionCancel = vi.fn();
      const onQuit = vi.fn();
      function CloseQuestion() {
        const open = usePreviewStore((s) => s.appModalOpen);
        return (
          <CloseDialog
            open={open}
            hasRunningAgent={false}
            onQuit={onQuit}
            onMinimize={() => undefined}
            onCancel={() => {
              usePreviewStore.getState().setAppModalOpen(false);
              onQuestionCancel();
            }}
            onCloseActionChange={() => undefined}
          />
        );
      }
      function Both({ approval }: { approval: boolean }) {
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
            <CloseQuestion />
          </DesignSystemProvider>
        );
      }

      beforeEach(() => {
        onQuestionCancel.mockReset();
        onQuit.mockReset();
      });
      afterEach(() => { usePreviewStore.setState({ appModalOpen: false }); });

      it.each(['awaiting_browser', 'exchanging'] as const)('keeps a sign-in that is %s through the question being asked and cancelled, and returns after the approval', async (status) => {
        useAccountStore.setState({ status });
        const view = render(<Both approval={false} />);
        const window = loginWindow();
        view.rerender(<Both approval />);
        expect(window).toHaveAttribute('hidden');

        act(() => { usePreviewStore.setState({ appModalOpen: true }); });
        expect(screen.getByRole('alertdialog', { name: '关闭窗口' })).toBeInTheDocument();
        expect(loginWindow()).toBe(window);
        expect(window).toHaveAttribute('hidden');
        expect(cancel).not.toHaveBeenCalled();

        await userEvent.setup().keyboard('{Escape}');
        expect(onQuestionCancel).toHaveBeenCalledTimes(1);
        expect(onApprovalAnswer).not.toHaveBeenCalled();
        expect(window).toHaveAttribute('hidden');
        expect(cancel).not.toHaveBeenCalled();

        view.rerender(<Both approval={false} />);
        expect(screen.getByRole('dialog', { name: '登录 / 注册' })).toBe(window);
        expect(window).not.toHaveAttribute('hidden');
        expect(cancel).not.toHaveBeenCalled();
        expect(useSettingsStore.getState().accountLoginOpen).toBe(true);
        expect(useAccountStore.getState().status).toBe(status);
        expect(onQuit).not.toHaveBeenCalled();
      });

      it('returns after an approval that is answered elsewhere while the question is up; the question is cancelled with it', () => {
        useAccountStore.setState({ status: 'awaiting_browser' });
        const view = render(<Both approval={false} />);
        const window = loginWindow();
        view.rerender(<Both approval />);
        act(() => { usePreviewStore.setState({ appModalOpen: true }); });

        view.rerender(<Both approval={false} />);
        expect(onQuestionCancel).toHaveBeenCalledTimes(1);
        expect(usePreviewStore.getState().appModalOpen).toBe(false);
        expect(screen.getByRole('dialog', { name: '登录 / 注册' })).toBe(window);
        expect(window).not.toHaveAttribute('hidden');
        expect(cancel).not.toHaveBeenCalled();
        expect(onQuit).not.toHaveBeenCalled();
        expect(useAccountStore.getState().status).toBe('awaiting_browser');
      });
    });
  });

  // The command approval of the task in view, asked through the real approval queue and drawn
  // the way the chat view draws it. The window declares its sign-in as work in progress and the
  // layer registry does the rest: that declaration alone keeps the sign-in going.
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
      // The approval takes no pointer press for a moment after it appears; the keyboard is never
      // held. It has been read by the time a case presses one of its buttons.
      passSettleInterval();
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

    it('closes for the approval when no sign-in is under way: nothing is cancelled, and it does not come back once the approval is answered', async () => {
      render(<><ChatApprovals /><AccountLoginDialog /></>, { wrapper: DesignSystemProvider });
      expect(shownLoginWindow()).not.toBeNull();

      const answers = askCommand();
      expect(screen.getByRole('alertdialog', { name: '操作确认' })).toBeInTheDocument();
      expect(useSettingsStore.getState().accountLoginOpen).toBe(false);
      expect(loginWindow()).toBeNull();
      expect(cancel).not.toHaveBeenCalled();
      expect(answers).toEqual([]);

      await userEvent.setup().click(screen.getByRole('button', { name: '取消' }));
      await act(async () => { await Promise.resolve(); });
      expect(answers).toEqual([false]);
      expect(loginWindow()).toBeNull();
      expect(useSettingsStore.getState().accountLoginOpen).toBe(false);
      expect(cancel).not.toHaveBeenCalled();
    });

    it('is turned away when it is opened while the approval is on screen, with nothing cancelled and the approval unanswered', () => {
      useSettingsStore.setState({ accountLoginOpen: false });
      render(<><ChatApprovals /><AccountLoginDialog /></>, { wrapper: DesignSystemProvider });
      const answers = askCommand();

      act(() => { useSettingsStore.getState().openAccountLogin(); });
      expect(useSettingsStore.getState().accountLoginOpen).toBe(false);
      expect(loginWindow()).toBeNull();
      expect(cancel).not.toHaveBeenCalled();
      expect(answers).toEqual([]);
      expect(screen.getByRole('alertdialog', { name: '操作确认' })).toBeInTheDocument();
    });

    // The close-window question was asked over the sign-in window. Both step aside for the
    // approval and return together: the focus belongs to the question on top.
    it('returns under the close-window question with the focus in the question: Enter minimizes and does not cancel the sign-in', async () => {
      const user = userEvent.setup();
      const onMinimize = vi.fn();
      const onQuit = vi.fn();
      function Question() {
        const open = usePreviewStore((s) => s.appModalOpen);
        return (
          <CloseDialog
            open={open}
            hasRunningAgent={false}
            onQuit={onQuit}
            onMinimize={onMinimize}
            onCancel={() => usePreviewStore.getState().setAppModalOpen(false)}
            onCloseActionChange={() => undefined}
          />
        );
      }
      useAccountStore.setState({ status: 'awaiting_browser' });
      try {
        render(<><ChatApprovals /><AccountLoginDialog /><Question /></>, { wrapper: DesignSystemProvider });
        act(() => { usePreviewStore.setState({ appModalOpen: true }); });
        expect(screen.getByRole('button', { name: '最小化到托盘' })).toHaveFocus();

        const answers = askCommand();
        expect(loginWindow()).toHaveAttribute('hidden');
        await user.click(screen.getByRole('button', { name: '取消' }));
        await act(async () => { await Promise.resolve(); });
        expect(answers).toEqual([false]);

        expect(loginWindow()).not.toHaveAttribute('hidden');
        expect(screen.getByRole('alertdialog', { name: '关闭窗口' })).not.toHaveAttribute('hidden');
        await waitFor(() => expect(screen.getByRole('button', { name: '最小化到托盘' })).toHaveFocus());

        await user.keyboard('{Enter}');
        expect(onMinimize).toHaveBeenCalledTimes(1);
        expect(cancel).not.toHaveBeenCalled();
        expect(onQuit).not.toHaveBeenCalled();
        expect(useSettingsStore.getState().accountLoginOpen).toBe(true);
        expect(useAccountStore.getState().status).toBe('awaiting_browser');
      } finally {
        usePreviewStore.setState({ appModalOpen: false });
      }
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

  // A file grant and a workspace request of the task in view, asked through the real queues and
  // drawn the way the chat view draws them. Both are approval layers: the window steps aside for
  // them with its sign-in going on.
  describe('when a file grant or a workspace request of the task in view arrives', () => {
    const cancel = vi.fn();
    function ChatGrants() {
      const file = useSyncExternalStore(subscribeToFilePermission, getPendingFilePermission);
      const workspace = useSyncExternalStore(subscribeToWorkspaceRequest, getPendingWorkspaceRequest);
      const inView = useChatStore((state) => state.activeConversationId);
      if (workspace && workspace.conversationId === inView) {
        return (
          <PermissionDialog
            key={workspace.id}
            request={{ type: 'folder-select', reason: workspace.reason, path: workspace.suggestedPath }}
            onAllow={() => undefined}
            onAuthorize={() => resolveWorkspaceRequest(workspace.suggestedPath ?? null)}
            onDeny={() => resolveWorkspaceRequest(null)}
          />
        );
      }
      if (!file || file.conversationId !== inView) return null;
      return (
        <PermissionDialog
          key={file.id}
          request={{ type: 'file-write', path: file.path }}
          onAllow={(duration) => resolveFilePermission(true, file.path, ['read', 'write', 'execute'], duration)}
          onDeny={() => resolveFilePermission(false)}
        />
      );
    }
    const shownLoginWindow = () => {
      const window = document.querySelector<HTMLElement>('[data-abu-account-dialog]');
      return window && !window.hasAttribute('hidden') ? window : null;
    };

    beforeEach(() => {
      cancel.mockReset();
      usePermissionStore.setState({ persistedGrants: {}, sessionGrants: {} });
      useChatStore.setState({ activeConversationId: 'conversation-in-view' });
      useSettingsStore.setState({ systemSettingsOpen: false, accountLoginOpen: true, viewMode: 'chat' });
      useAccountStore.setState({ status: 'signed_out', cancel });
    });
    afterEach(() => {
      act(() => { drainFilePermissionQueue(); drainWorkspaceRequest(); });
      vi.useRealTimers();
      useChatStore.setState({ activeConversationId: null });
    });

    it.each(['awaiting_browser', 'exchanging'] as const)('goes on with a sign-in that is %s while a file grant is asked and denied', async (status) => {
      useAccountStore.setState({ status });
      render(<><ChatGrants /><AccountLoginDialog /></>, { wrapper: DesignSystemProvider });
      expect(shownLoginWindow()).not.toBeNull();

      const answers: boolean[] = [];
      act(() => {
        void approvalBridge.request('file-permission', {
          conversationId: 'conversation-in-view',
          payload: { path: '/fake/project/notes.txt', capability: 'write', toolName: 'write_file' },
        }).then((answer) => { answers.push(answer); });
      });
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByRole('alertdialog', { name: '文件写入权限' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '拒绝' })).toHaveFocus();
      expect(shownLoginWindow()).toBeNull();
      expect(cancel).not.toHaveBeenCalled();
      expect(answers).toEqual([]);

      await userEvent.setup().keyboard('{Enter}');
      await act(async () => { await Promise.resolve(); });
      expect(answers).toEqual([false]);
      expect(usePermissionStore.getState().hasPermission('/fake/project/notes.txt', 'write')).toBe(false);
      expect(shownLoginWindow()).not.toBeNull();
      expect(cancel).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().accountLoginOpen).toBe(true);
      expect(useAccountStore.getState().status).toBe(status);
    });

    it('goes on with a sign-in while a workspace request is shown and answers itself after 60 seconds', async () => {
      vi.useFakeTimers();
      useAccountStore.setState({ status: 'awaiting_browser' });
      render(<><ChatGrants /><AccountLoginDialog /></>, { wrapper: DesignSystemProvider });

      const answers: (string | null)[] = [];
      act(() => {
        void requestWorkspace('needs a folder', 'conversation-in-view', '/fake/project').then((answer) => { answers.push(answer); });
      });
      expect(screen.getByRole('alertdialog', { name: '工作区访问权限' })).toBeInTheDocument();
      expect(shownLoginWindow()).toBeNull();

      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(answers).toEqual([null]);
      expect(screen.queryByRole('alertdialog', { name: '工作区访问权限' })).toBeNull();
      expect(shownLoginWindow()).not.toBeNull();
      expect(cancel).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().accountLoginOpen).toBe(true);
      expect(useAccountStore.getState().status).toBe('awaiting_browser');
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
