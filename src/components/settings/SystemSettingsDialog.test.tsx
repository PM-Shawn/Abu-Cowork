// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import AccountLoginDialog from '@/components/account/AccountLoginDialog';
import CloseDialog from '@/components/common/CloseDialog';
import { Button } from '@/components/ds/button';
import { Dialog } from '@/components/ds/dialog';
import { DesignSystemProvider } from '@/components/ds/provider';
import { __resetAccountStoreForTest, useAccountStore } from '@/core/account/accountStore';
import { drainConfirmationQueue, requestCommandConfirmationForConversation } from '@/core/agent/permissionBridge';
import { getI18n, initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useSettingsStore } from '@/stores/settingsStore';
import SystemSettingsDialog from './SystemSettingsDialog';

const platformMock = vi.hoisted(() => ({ mac: false }));
vi.mock('@/utils/platform', () => ({
  isMacOS: () => platformMock.mac,
  isWindows: () => !platformMock.mac,
}));

// How many times the view inside the window has rendered.
const viewRenders = vi.hoisted(() => ({ count: 0 }));
// A form window a settings page opens inside the settings window (the add-service form), and
// what it reports to the layer registry: unsaved input, or work that closing it would cancel.
const formInside = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let state = { open: false, busy: false, dirty: false };
  return {
    closes: [] as boolean[],
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    get: () => state,
    set: (next: Partial<typeof state>) => {
      state = { ...state, ...next };
      for (const listener of listeners) listener();
    },
  };
});
vi.mock('@/components/settings/SystemSettingsModal', async () => {
  const { useSyncExternalStore } = await import('react');
  const { Button } = await import('@/components/ds/button');
  const { Dialog } = await import('@/components/ds/dialog');
  const { Select } = await import('@/components/ds/select');
  const { TextField } = await import('@/components/ds/text-field');
  function FormInside() {
    const form = useSyncExternalStore(formInside.subscribe, formInside.get);
    return (
      <Dialog
        open={form.open}
        busy={form.busy}
        dirty={form.dirty}
        onOpenChange={(next) => {
          formInside.closes.push(next);
          formInside.set({ open: next });
        }}
        title="Add a service"
      >
        <TextField aria-label="Service address" defaultValue="" />
      </Dialog>
    );
  }
  return {
    default: () => {
      viewRenders.count += 1;
      return (
        <div>
          <nav>
            <Button>Another page</Button>
            <Button aria-current="page">Page in view</Button>
          </nav>
          <Button>First control</Button>
          <Select
            label="Sample choice"
            value="one"
            onValueChange={() => undefined}
            options={[{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }]}
          />
          <FormInside />
        </div>
      );
    },
  };
});

function renderDialog() {
  return render(<SystemSettingsDialog />, { wrapper: DesignSystemProvider });
}

// An approval of a task, as an approval layer the tests raise and answer.
const useApproval = create(() => ({ open: false }));
const onApprovalAnswer = vi.fn();
function Approval() {
  const { open } = useApproval();
  return (
    <Dialog
      open={open}
      onOpenChange={onApprovalAnswer}
      layer="approval"
      role="alertdialog"
      outsidePress="ignore"
      title="Confirm Action"
      initialFocus={(content) => content.querySelector<HTMLElement>('[data-approval-cancel]')}
      footer={<><Button data-approval-cancel="">Cancel the command</Button><Button variant="primary">Run the command</Button></>}
    />
  );
}
const approval = () => screen.queryByRole('alertdialog', { name: 'Confirm Action' });

// The close-window question as the app mounts it: `appModalOpen` is its switch.
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

// The window opened from a button on the page, the way the account menu opens it.
function renderWithOpener() {
  return render(
    <>
      <Button onClick={() => useSettingsStore.getState().openSystemSettings()}>Open settings</Button>
      <SystemSettingsDialog />
    </>,
    { wrapper: DesignSystemProvider },
  );
}

// Radix hands focus back from a timer once the dialog has gone.
async function flushClose() {
  await act(() => vi.runOnlyPendingTimersAsync());
}

const settingsWindow = () => document.querySelector('[data-abu-settings-dialog]');
const isOpen = () => useSettingsStore.getState().systemSettingsOpen;

describe('SystemSettingsDialog', () => {
  beforeAll(() => {
    // happy-dom lacks the pointer-capture and scroll calls Radix Select makes while opening.
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.setPointerCapture ??= () => undefined;
    Element.prototype.releasePointerCapture ??= () => undefined;
    Element.prototype.scrollIntoView ??= () => undefined;
  });

  beforeEach(() => {
    initLanguage('zh-CN');
    platformMock.mac = false;
    viewRenders.count = 0;
    formInside.set({ open: false, busy: false, dirty: false });
    formInside.closes.length = 0;
    onApprovalAnswer.mockReset();
    onQuestionCancel.mockReset();
    onQuit.mockReset();
    useApproval.setState({ open: false });
    usePreviewStore.setState({ appModalOpen: false });
    useSettingsStore.setState({ systemSettingsOpen: true });
  });

  afterEach(() => {
    cleanup();
    formInside.set({ open: false, busy: false, dirty: false });
    useApproval.setState({ open: false });
    usePreviewStore.setState({ appModalOpen: false });
    useSettingsStore.setState({ systemSettingsOpen: false });
  });

  // macOS paints its window buttons over the top 44px of the window
  // (`trafficLightPosition` in `electron/windowChrome.cjs`), so the settings window starts
  // 48px down there and 24px down elsewhere.
  it('starts below the window buttons on macOS and keeps the settings-window box', () => {
    platformMock.mac = true;
    renderDialog();
    expect(settingsWindow()).toHaveClass('top-12');
    expect(settingsWindow()).toHaveClass('m-auto');
    expect(settingsWindow()).toHaveClass('max-h-[840px]');
  });

  it('starts nearer the top on other platforms', () => {
    renderDialog();
    expect(settingsWindow()).toHaveClass('top-6');
    expect(settingsWindow()).not.toHaveClass('top-12');
  });

  it('is a dialog named after the settings title, and it and its scrim stay out of the window drag lanes', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: getI18n().settings.title });
    expect(dialog).toBe(settingsWindow());
    expect(dialog).toHaveAttribute('data-electron-no-drag');
    const scrim = document.querySelector('.bg-scrim');
    expect(scrim).not.toBeNull();
    expect(scrim).toHaveAttribute('data-electron-no-drag');
  });

  it('closes from the close button', async () => {
    const user = userEvent.setup();
    renderDialog();
    const close = document.querySelector<HTMLElement>('[data-abu-settings-close]');
    expect(close).toHaveAccessibleName(getI18n().common.close);
    await user.click(close!);
    expect(isOpen()).toBe(false);
    expect(settingsWindow()).toBeNull();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.keyboard('{Escape}');
    expect(isOpen()).toBe(false);
  });

  it('closes one layer per Escape: an open select first, then the settings window', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('combobox', { name: 'Sample choice' }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(isOpen()).toBe(true);
    expect(settingsWindow()).not.toBeNull();

    await user.keyboard('{Escape}');
    expect(isOpen()).toBe(false);
  });

  // The question is about what is on screen: it stacks over the settings window.
  describe('with the close-window question', () => {
    const renderWithQuestion = () => render(<><SystemSettingsDialog /><CloseQuestion /></>, { wrapper: DesignSystemProvider });
    const question = () => screen.queryByRole('alertdialog', { name: '关闭窗口' });

    it('stays open under the question, and one Escape closes the question alone', async () => {
      const user = userEvent.setup();
      renderWithQuestion();
      const window = settingsWindow();
      act(() => usePreviewStore.setState({ appModalOpen: true }));

      expect(question()).toBeInTheDocument();
      expect(isOpen()).toBe(true);
      expect(settingsWindow()).toBe(window);
      expect(window).toHaveAttribute('data-state', 'open');
      expect(window).not.toHaveAttribute('hidden');

      await user.keyboard('{Escape}');
      expect(onQuestionCancel).toHaveBeenCalledTimes(1);
      expect(question()).toBeNull();
      expect(isOpen()).toBe(true);
      expect(settingsWindow()).toBe(window);
      expect(onQuit).not.toHaveBeenCalled();
    });

    // A window that opens is a new thing on screen: the question about the old one is dropped.
    it('cancels the question, without quitting, when the window is opened while the question is up', () => {
      useSettingsStore.setState({ systemSettingsOpen: false });
      usePreviewStore.setState({ appModalOpen: true });
      renderWithQuestion();
      expect(question()).toBeInTheDocument();

      act(() => useSettingsStore.getState().openSystemSettings());
      expect(isOpen()).toBe(true);
      expect(settingsWindow()).not.toBeNull();
      expect(onQuestionCancel).toHaveBeenCalledTimes(1);
      expect(usePreviewStore.getState().appModalOpen).toBe(false);
      expect(onQuit).not.toHaveBeenCalled();
    });
  });

  // Approvals are layers of their own kind: the layer registry closes the window for one, or has
  // it step aside when a form inside it holds work in flight. The window watches no queue itself.
  describe('when an approval arrives', () => {
    const renderWithApproval = () => render(<><SystemSettingsDialog /><Approval /></>, { wrapper: DesignSystemProvider });

    it('closes for it when nothing in it is in progress, and the approval is not answered', () => {
      renderWithApproval();
      expect(settingsWindow()).not.toBeNull();

      act(() => useApproval.setState({ open: true }));
      expect(isOpen()).toBe(false);
      expect(settingsWindow()).toBeNull();
      expect(approval()).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cancel the command' })).toHaveFocus();
      expect(onApprovalAnswer).not.toHaveBeenCalled();
    });

    it('does not come back by itself once the approval is answered', () => {
      renderWithApproval();
      act(() => useApproval.setState({ open: true }));
      act(() => useApproval.setState({ open: false }));
      expect(isOpen()).toBe(false);
      expect(settingsWindow()).toBeNull();
    });

    it('is turned away when it is opened while the approval is on screen: closed at once, never on the page', () => {
      useSettingsStore.setState({ systemSettingsOpen: false });
      useApproval.setState({ open: true });
      renderWithApproval();
      let seen = false;
      const observer = new MutationObserver(() => { if (settingsWindow()) seen = true; });
      observer.observe(document.body, { childList: true, subtree: true });
      try {
        act(() => useSettingsStore.getState().openSystemSettings());
        observer.takeRecords();
        expect(seen).toBe(false);
        expect(isOpen()).toBe(false);
        expect(settingsWindow()).toBeNull();
        expect(approval()).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Cancel the command' })).toHaveFocus();
        expect(onApprovalAnswer).not.toHaveBeenCalled();
      } finally {
        observer.disconnect();
      }
    });

    it('opens while an approval waits in a queue that no view draws', async () => {
      useSettingsStore.setState({ systemSettingsOpen: false });
      useChatStore.setState({ activeConversationId: 'conversation-in-view' });
      const answers: boolean[] = [];
      act(() => {
        void requestCommandConfirmationForConversation(
          { command: 'echo not-a-real-command', level: 'warn', reason: 'needs a look' },
          'conversation-in-view',
        ).then((answer) => { answers.push(answer); });
      });
      try {
        renderDialog();
        act(() => useSettingsStore.getState().openSystemSettings());
        expect(isOpen()).toBe(true);
        expect(screen.getByRole('dialog', { name: getI18n().settings.title })).toBeInTheDocument();
        expect(answers).toEqual([]);
      } finally {
        act(() => { drainConfirmationQueue(); });
        useChatStore.setState({ activeConversationId: null });
      }
    });

    // The close-window question was asked over the settings window with a form at work in it.
    // All three step aside for the approval and return together: the question is on top, so the
    // focus is in the question, not in a field underneath it.
    it('returns under the close-window question with the focus in the question: Enter minimizes and no key reaches the form', async () => {
      const user = userEvent.setup();
      const onMinimize = vi.fn();
      function Question() {
        const open = usePreviewStore((s) => s.appModalOpen);
        return (
          <CloseDialog
            open={open}
            hasRunningAgent={false}
            onQuit={onQuit}
            onMinimize={onMinimize}
            onCancel={onQuestionCancel}
            onCloseActionChange={() => undefined}
          />
        );
      }
      render(<><SystemSettingsDialog /><Approval /><Question /></>, { wrapper: DesignSystemProvider });
      act(() => formInside.set({ open: true, busy: true }));
      const field = screen.getByRole('textbox', { name: 'Service address' });
      await user.type(field, 'https://service.example.invalid');
      act(() => usePreviewStore.setState({ appModalOpen: true }));
      expect(screen.getByRole('button', { name: '最小化到托盘' })).toHaveFocus();

      act(() => useApproval.setState({ open: true }));
      expect(screen.getByRole('button', { name: 'Cancel the command' })).toHaveFocus();
      act(() => useApproval.setState({ open: false }));

      expect(settingsWindow()).not.toHaveAttribute('hidden');
      expect(screen.getByRole('alertdialog', { name: '关闭窗口' })).not.toHaveAttribute('hidden');
      await waitFor(() => expect(screen.getByRole('button', { name: '最小化到托盘' })).toHaveFocus());

      await user.keyboard('x');
      expect(field).toHaveValue('https://service.example.invalid');
      await user.keyboard('{Enter}');
      expect(onMinimize).toHaveBeenCalledTimes(1);
      expect(onQuit).not.toHaveBeenCalled();
      expect(formInside.closes).toEqual([]);
      expect(isOpen()).toBe(true);
    });

    describe('with a form inside it whose work would be cancelled by closing it', () => {
      it('steps aside with the form, neither closed, and both are back as they were when the approval has gone', async () => {
        const user = userEvent.setup();
        renderWithApproval();
        act(() => formInside.set({ open: true, busy: true }));
        const window = settingsWindow();
        const form = screen.getByRole('dialog', { name: 'Add a service' });
        await user.type(screen.getByRole('textbox', { name: 'Service address' }), 'https://service.example.invalid');

        act(() => useApproval.setState({ open: true }));
        expect(approval()).toBeInTheDocument();
        expect(isOpen()).toBe(true);
        expect(settingsWindow()).toBe(window);
        expect(window).toHaveAttribute('hidden');
        expect(form).toHaveAttribute('hidden');
        expect(formInside.closes).toEqual([]);
        expect(screen.queryByRole('dialog')).toBeNull();

        // The keyboard acts on the approval alone.
        await user.keyboard('{Escape}');
        expect(onApprovalAnswer.mock.calls).toEqual([[false]]);
        expect(isOpen()).toBe(true);
        expect(formInside.closes).toEqual([]);

        act(() => useApproval.setState({ open: false }));
        expect(settingsWindow()).toBe(window);
        expect(window).not.toHaveAttribute('hidden');
        expect(form).not.toHaveAttribute('hidden');
        expect(screen.getByRole('textbox', { name: 'Service address' })).toHaveValue('https://service.example.invalid');
        expect(isOpen()).toBe(true);
        expect(formInside.closes).toEqual([]);
      });

      // The sign-in window opens by itself under the approval with a sign-in under way. When the
      // approval has gone it is shown; the settings window is not shown over it, nor it over
      // the settings window, and neither is closed for the other.
      it('waits, with its form, behind a sign-in window that opened under the approval, and returns when that window has closed', () => {
        const cancelSignIn = vi.fn();
        __resetAccountStoreForTest();
        useAccountStore.setState({ status: 'awaiting_browser', cancel: cancelSignIn });
        try {
          render(<><SystemSettingsDialog /><AccountLoginDialog /><Approval /></>, { wrapper: DesignSystemProvider });
          act(() => formInside.set({ open: true, busy: true }));
          const window = settingsWindow();
          const form = screen.getByRole('dialog', { name: 'Add a service' });

          act(() => useApproval.setState({ open: true }));
          expect(window).toHaveAttribute('hidden');
          act(() => useSettingsStore.getState().openAccountLogin());
          expect(document.querySelector('[data-abu-account-dialog]')).toBeNull();
          expect(useSettingsStore.getState().accountLoginOpen).toBe(true);

          act(() => useApproval.setState({ open: false }));
          const signIn = document.querySelector<HTMLElement>('[data-abu-account-dialog]');
          expect(signIn).not.toBeNull();
          expect(signIn).not.toHaveAttribute('hidden');
          expect(window).toHaveAttribute('hidden');
          expect(form).toHaveAttribute('hidden');
          expect(isOpen()).toBe(true);
          expect(useSettingsStore.getState().accountLoginOpen).toBe(true);
          expect(cancelSignIn).not.toHaveBeenCalled();
          expect(formInside.closes).toEqual([]);

          // The sign-in finishes in the browser: its window closes itself.
          act(() => {
            useAccountStore.setState({ status: 'signed_in', account: { serverUrl: 'https://accounts.example.invalid', userId: 'user-1', kind: 'personal', name: 'Ada', email: null } });
          });
          expect(useSettingsStore.getState().accountLoginOpen).toBe(false);
          expect(settingsWindow()).toBe(window);
          expect(window).not.toHaveAttribute('hidden');
          expect(form).not.toHaveAttribute('hidden');
          expect(isOpen()).toBe(true);
          expect(cancelSignIn).not.toHaveBeenCalled();
          expect(formInside.closes).toEqual([]);
        } finally {
          useSettingsStore.setState({ accountLoginOpen: false });
          __resetAccountStoreForTest();
        }
      });
    });

    describe('with a form inside it that holds unsaved input', () => {
      it('asks on the form whether to discard it; the approval waits off the page, unanswered', async () => {
        renderWithApproval();
        act(() => formInside.set({ open: true, dirty: true }));

        act(() => useApproval.setState({ open: true }));
        expect(await screen.findByRole('alertdialog', { name: '放弃这些内容？' })).toBeInTheDocument();
        expect(approval()).toBeNull();
        expect(isOpen()).toBe(true);
        expect(settingsWindow()).not.toBeNull();
        expect(formInside.closes).toEqual([]);
        expect(onApprovalAnswer).not.toHaveBeenCalled();
      });

      it('keeps the window and the form after 「继续填写」, with the approval still waiting; it is shown once the form has closed', async () => {
        const user = userEvent.setup();
        renderWithApproval();
        act(() => formInside.set({ open: true, dirty: true }));
        act(() => useApproval.setState({ open: true }));

        await user.click(await screen.findByRole('button', { name: '继续填写' }));
        expect(isOpen()).toBe(true);
        expect(screen.getByRole('dialog', { name: 'Add a service' })).toBeInTheDocument();
        expect(approval()).toBeNull();
        expect(onApprovalAnswer).not.toHaveBeenCalled();

        // The form is saved and closes: the approval has its turn, and the settings window,
        // which holds nothing now, closes for it.
        act(() => formInside.set({ open: false, dirty: false }));
        expect(approval()).toBeInTheDocument();
        expect(isOpen()).toBe(false);
        expect(onApprovalAnswer).not.toHaveBeenCalled();
      });

      it('closes the window and the form after 「放弃」 and shows the approval, unanswered', async () => {
        const user = userEvent.setup();
        renderWithApproval();
        act(() => formInside.set({ open: true, dirty: true }));
        act(() => useApproval.setState({ open: true }));

        await user.click(await screen.findByRole('button', { name: '放弃' }));
        expect(isOpen()).toBe(false);
        expect(approval()).toBeInTheDocument();
        expect(onApprovalAnswer).not.toHaveBeenCalled();
      });
    });
  });

  it('opens with focus on the navigation row of the page in view', async () => {
    const user = userEvent.setup();
    useSettingsStore.setState({ systemSettingsOpen: false });
    renderWithOpener();
    await user.click(screen.getByRole('button', { name: 'Open settings' }));

    expect(screen.getByRole('button', { name: 'Page in view' })).toHaveFocus();
  });

  describe('focus when the window closes', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      useSettingsStore.setState({ systemSettingsOpen: false });
    });

    afterEach(() => { vi.useRealTimers(); });

    it('gives focus back to its opener when the user closes it', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderWithOpener();
      const opener = screen.getByRole('button', { name: 'Open settings' });
      await user.click(opener);
      expect(settingsWindow()).not.toBeNull();

      await user.keyboard('{Escape}');
      await flushClose();

      expect(settingsWindow()).toBeNull();
      expect(opener).toHaveFocus();
    });

    // The approval has the page and the focus. Focus on the opener underneath it would let
    // Enter open the opener's menu behind the approval.
    it('leaves the focus on the approval that took its place, and gives it to its opener once the approval is answered', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(
        <>
          <Button onClick={() => useSettingsStore.getState().openSystemSettings()}>Open settings</Button>
          <SystemSettingsDialog />
          <Approval />
        </>,
        { wrapper: DesignSystemProvider },
      );
      const opener = screen.getByRole('button', { name: 'Open settings' });
      await user.click(opener);
      expect(settingsWindow()).not.toBeNull();

      act(() => useApproval.setState({ open: true }));
      await flushClose();

      expect(settingsWindow()).toBeNull();
      expect(isOpen()).toBe(false);
      expect(screen.getByRole('button', { name: 'Cancel the command' })).toHaveFocus();
      expect(opener).not.toHaveFocus();

      act(() => useApproval.setState({ open: false }));
      await flushClose();
      expect(opener).toHaveFocus();
      expect(onApprovalAnswer).not.toHaveBeenCalled();
    });
  });

  // The app around the window renders again for every piece of a streamed reply. The window
  // takes nothing from it, so the page of settings on screen stays as it is.
  it('does not render again when the app around it does', async () => {
    const user = userEvent.setup();
    function AppAround() {
      const [pieces, setPieces] = useState(0);
      return (
        <>
          <Button onClick={() => setPieces(pieces + 1)}>Piece {pieces}</Button>
          <SystemSettingsDialog />
        </>
      );
    }
    useSettingsStore.setState({ systemSettingsOpen: false });
    render(<AppAround />, { wrapper: DesignSystemProvider });
    const piece = screen.getByRole('button', { name: 'Piece 0' });
    // Three pieces arrive before the window opens: it is not on the page, and stays so.
    await user.click(piece);
    await user.click(piece);
    await user.click(piece);
    expect(piece).toHaveTextContent('Piece 3');
    expect(viewRenders.count).toBe(0);

    act(() => useSettingsStore.getState().openSystemSettings());
    expect(settingsWindow()).not.toBeNull();
    const rendered = viewRenders.count;
    expect(rendered).toBeGreaterThan(0);

    // The window is modal, so the pieces arrive by a state change of the app, not by a press.
    for (let i = 0; i < 3; i += 1) act(() => piece.click());
    expect(piece).toHaveTextContent('Piece 6');
    expect(viewRenders.count).toBe(rendered);
  });

  it('draws no blurred scrim', () => {
    renderDialog();
    expect(settingsWindow()).not.toBeNull();
    expect(document.querySelector('[class*="backdrop-blur"]')).toBeNull();
  });
});
