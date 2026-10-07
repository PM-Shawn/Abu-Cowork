// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { create } from 'zustand';
import { Button } from '@/components/ds/button';
import { Dialog } from '@/components/ds/dialog';
import { DesignSystemProvider } from '@/components/ds/provider';
import { TextArea } from '@/components/ds/text-area';
import { initLanguage } from '@/i18n';
import {
  drainCapabilitySetupRequests,
  getPendingCapabilitySetup,
  requestCapabilitySetup,
  resolveCapabilitySetup,
  restoreComputerUseSetupRequest,
} from '@/core/capabilityPlugins/setupBridge';
import { runAgentLoopDispatched } from '@/core/agent/agentLoopRunner';
import { useChatStore } from '@/stores/chatStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { useToastStore } from '@/stores/toastStore';
import AccountLoginDialog from '@/components/account/AccountLoginDialog';
import CloseDialog from '@/components/common/CloseDialog';
import { __resetAccountStoreForTest, useAccountStore } from '@/core/account/accountStore';
import CapabilitySetupDialog from './CapabilitySetupDialog';
import SystemSettingsDialog from './SystemSettingsDialog';
import { useImageLightboxStore } from '@/stores/imageLightboxStore';
import ImageLightbox from '@/components/chat/ImageLightbox';
import { passSettleInterval } from '@/test/dsWindows';

const restartAppMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@/core/updates/checker', () => ({
  restartApp: restartAppMock,
}));

vi.mock('@/core/agent/agentLoopRunner', () => ({
  runAgentLoopDispatched: vi.fn(),
}));

// The real bridge, with the one call that answers a request recorded.
vi.mock('@/core/capabilityPlugins/setupBridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/capabilityPlugins/setupBridge')>();
  return { ...actual, resolveCapabilitySetup: vi.fn(actual.resolveCapabilitySetup) };
});

// The settings window with a stand-in for its pages.
vi.mock('@/components/settings/SystemSettingsModal', async () => {
  const { Button } = await import('@/components/ds/button');
  return { default: () => <Button>a settings control</Button> };
});

// Cancel comes first, as on the real page a task opens: its header starts with Cancel.
vi.mock('./sections/CapabilitiesSection', async () => {
  const { Button } = await import('@/components/ds/button');
  return {
    default: ({
      setupTarget,
      computerUseRequirements,
      onSetupComplete,
      onSetupCancel,
      onSetupRelaunch,
    }: {
      setupTarget: string;
      computerUseRequirements?: { screenRead: boolean; uiControl: boolean };
      onSetupComplete: () => void;
      onSetupCancel: () => void;
      onSetupRelaunch?: () => void;
    }) => (
      <div>
        <span>setup:{setupTarget}</span>
        <span>requirements:{JSON.stringify(computerUseRequirements)}</span>
        <Button onClick={onSetupCancel}>cancel setup</Button>
        <Button onClick={onSetupComplete}>complete setup</Button>
        {onSetupRelaunch && <Button onClick={onSetupRelaunch}>restart setup</Button>}
      </div>
    ),
  };
});

function renderWindow(around?: ReactNode) {
  return render(<>{around}<CapabilitySetupDialog /></>, { wrapper: DesignSystemProvider });
}

/** The dimmed area around the window. */
function findScrim(): HTMLElement {
  const scrim = document.querySelector<HTMLElement>('.bg-scrim');
  if (!scrim) throw new Error('The setup window has no scrim');
  return scrim;
}

// Another dialog of the app, opened and closed from the test.
const useOtherDialog = create(() => ({ open: false, dirty: false }));

function OtherDialog() {
  const { open, dirty } = useOtherDialog();
  return (
    <Dialog open={open} onOpenChange={(next) => useOtherDialog.setState({ open: next })} title="Other dialog" dirty={dirty}>
      <Button>inside the other dialog</Button>
    </Dialog>
  );
}

const setupWindow = () => screen.queryByRole('dialog', { name: /^Connect My Chrome$|^Enable Computer Use$/ });

// Radix hands focus back from a timer once a dialog has gone. One millisecond is enough for it
// and leaves the bridge's own five-minute timeout alone.
async function flushClose() {
  await act(() => vi.advanceTimersByTimeAsync(1));
}

async function clickScrim() {
  await userEvent.setup().click(findScrim());
}

/** A request from a running task, and whether the task has been answered yet. */
function requestFromTask(target: 'chrome' | 'computer' = 'chrome', toolCallId = 'tool-pending') {
  const state = { settled: false, result: undefined as boolean | undefined };
  const promise = requestCapabilitySetup(target, {
    conversationId: 'conversation-pending',
    toolCallId,
    interactionMode: 'foreground',
  }).then((ready) => {
    state.settled = true;
    state.result = ready;
    return ready;
  });
  return { promise, state };
}

describe('CapabilitySetupDialog', () => {
  beforeEach(() => {
    initLanguage('en-US');
    drainCapabilitySetupRequests();
    useImageLightboxStore.getState().close();
    localStorage.clear();
    restartAppMock.mockClear();
    vi.mocked(resolveCapabilitySetup).mockClear();
  });

  it('passes the requesting task permission scope into Computer Use setup', async () => {
    const resultPromise = requestCapabilitySetup('computer', {
      conversationId: 'conversation-ax',
      toolCallId: 'tool-ax',
      interactionMode: 'foreground',
    }, {
      computerUseRequirements: { screenRead: false, uiControl: true },
    });

    renderWindow();
    expect(screen.getByText(
      'requirements:{"screenRead":false,"uiControl":true}',
    )).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'cancel setup' }));
    await expect(resultPromise).resolves.toBe(false);
  });

  afterEach(() => {
    drainCapabilitySetupRequests();
    useImageLightboxStore.getState().close();
    useOtherDialog.setState({ open: false, dirty: false });
    usePreviewStore.setState({ appModalOpen: false });
    cleanup();
  });

  it('resolves the exact requesting task after setup completes', async () => {
    const resultPromise = requestCapabilitySetup('computer', {
      conversationId: 'conversation-1',
      toolCallId: 'tool-1',
      interactionMode: 'foreground',
    });

    renderWindow();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('setup:computer')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'complete setup' }));
    await expect(resultPromise).resolves.toBe(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('cancels setup with Escape without enabling the capability', async () => {
    const resultPromise = requestCapabilitySetup('chrome', {
      conversationId: 'conversation-2',
      toolCallId: 'tool-2',
      interactionMode: 'foreground',
    });

    renderWindow();
    fireEvent.keyDown(document, { key: 'Escape' });

    await expect(resultPromise).resolves.toBe(false);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  describe('every way out other than the page saying setup is complete answers no', () => {
    it('answers no when the area around the window is clicked', async () => {
      const { promise } = requestFromTask();
      renderWindow();

      await clickScrim();

      await expect(promise).resolves.toBe(false);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('answers no from the Close button in the corner', async () => {
      const { promise } = requestFromTask();
      renderWindow();

      // The window takes no pointer press inside its box for a moment after it appears.
      passSettleInterval();
      await userEvent.setup().click(screen.getByRole('button', { name: 'Close' }));

      await expect(promise).resolves.toBe(false);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it.each([
      ['Enter', '{Enter}'],
      ['Space', ' '],
    ])('answers no when %s is pressed as soon as the window opens', async (_name, keys) => {
      const { promise, state } = requestFromTask();
      renderWindow();
      await screen.findByRole('dialog');

      await userEvent.setup().keyboard(keys);

      await waitFor(() => expect(state.settled).toBe(true));
      await expect(promise).resolves.toBe(false);
    });

    it('does not answer when the window is taken off the page', async () => {
      const { state } = requestFromTask();
      const view = renderWindow();
      const request = getPendingCapabilitySetup();

      view.unmount();
      await Promise.resolve();

      expect(resolveCapabilitySetup).not.toHaveBeenCalled();
      expect(state.settled).toBe(false);
      expect(getPendingCapabilitySetup()).toBe(request);
    });
  });

  describe('the answer goes to the request on screen', () => {
    it.each([
      ['Escape', () => { fireEvent.keyDown(document, { key: 'Escape' }); }, false],
      ['the area around the window', () => clickScrim(), false],
      ['the Close button', () => { fireEvent.click(screen.getByRole('button', { name: 'Close' })); }, false],
      ['Cancel on the page', () => { fireEvent.click(screen.getByRole('button', { name: 'cancel setup' })); }, false],
      ['the page reporting completion', () => { fireEvent.click(screen.getByRole('button', { name: 'complete setup' })); }, true],
    ])('%s answers with the id of that request', async (_name, leave, answer) => {
      const { promise } = requestFromTask('chrome', 'tool-on-screen');
      // A second task waits its turn; it must not be the one that gets the answer.
      const waiting = requestFromTask('chrome', 'tool-waiting');
      renderWindow();
      const id = getPendingCapabilitySetup()?.id;
      expect(id).toContain('tool-on-screen');

      await leave();

      await expect(promise).resolves.toBe(answer);
      expect(resolveCapabilitySetup).toHaveBeenCalledTimes(1);
      expect(resolveCapabilitySetup).toHaveBeenCalledWith(id, answer);
      expect(waiting.state.settled).toBe(false);
      expect(getPendingCapabilitySetup()?.id).toContain('tool-waiting');
    });
  });

  // The image viewer is still the legacy full-window layer. It closes itself the moment a request
  // is pending, so the request is neither answered nor lost: its window is what the user sees.
  describe('a request that arrives while the image viewer is open', () => {
    async function arriveOverTheViewer() {
      renderWindow(
        <>
          <Button>image opener</Button>
          <ImageLightbox />
        </>,
      );
      const opener = screen.getByRole('button', { name: 'image opener' });
      act(() => {
        useImageLightboxStore.getState().open([{ id: 'image-1', data: 'cG5n', mediaType: 'image/png' }], 0, opener);
      });
      await screen.findByRole('dialog', { name: 'Image preview' });
      let request!: ReturnType<typeof requestFromTask>;
      act(() => { request = requestFromTask(); });
      return request;
    }

    it('closes the viewer and shows the window in its place, unanswered', async () => {
      const { state } = await arriveOverTheViewer();

      expect(await screen.findByRole('dialog', { name: 'Connect My Chrome' })).toBeInTheDocument();
      expect(screen.queryByRole('dialog', { name: 'Image preview' })).toBeNull();
      expect(useImageLightboxStore.getState().isOpen).toBe(false);
      expect(screen.getAllByRole('dialog')).toHaveLength(1);
      expect(resolveCapabilitySetup).not.toHaveBeenCalled();
      expect(state.settled).toBe(false);
      expect(getPendingCapabilitySetup()?.id).toContain('tool-pending');
    });

    it('is refused by one Escape once its window is the only layer, and by nothing before that', async () => {
      const { promise, state } = await arriveOverTheViewer();
      await screen.findByRole('dialog', { name: 'Connect My Chrome' });
      expect(state.settled).toBe(false);

      await userEvent.setup().keyboard('{Escape}');
      await expect(promise).resolves.toBe(false);
      expect(resolveCapabilitySetup).toHaveBeenCalledTimes(1);
    });

    it('keeps the viewer closed while the request waits: one opened then closes at once', async () => {
      const { state } = await arriveOverTheViewer();
      await screen.findByRole('dialog', { name: 'Connect My Chrome' });

      act(() => {
        useImageLightboxStore.getState().open([{ id: 'image-2', data: 'cG5n', mediaType: 'image/png' }], 0);
      });
      expect(useImageLightboxStore.getState().isOpen).toBe(false);
      expect(screen.queryByRole('dialog', { name: 'Image preview' })).toBeNull();
      expect(screen.getByRole('dialog', { name: 'Connect My Chrome' })).toBeInTheDocument();
      expect(resolveCapabilitySetup).not.toHaveBeenCalled();
      expect(state.settled).toBe(false);
    });
  });

  it('takes the place of an open window that holds nothing: that window is closed, and the request is not answered', async () => {
    useOtherDialog.setState({ open: true, dirty: false });
    renderWindow(<OtherDialog />);
    await screen.findByRole('dialog', { name: 'Other dialog' });

    let request!: ReturnType<typeof requestFromTask>;
    act(() => { request = requestFromTask(); });

    expect(await screen.findByRole('dialog', { name: 'Connect My Chrome' })).toBeInTheDocument();
    expect(useOtherDialog.getState().open).toBe(false);
    await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(1));
    expect(resolveCapabilitySetup).not.toHaveBeenCalled();
    expect(request.state.settled).toBe(false);
  });

  it('hands focus from a closing lightbox to asynchronously requested setup', async () => {
    renderWindow(
      <>
        <Button>image opener</Button>
        <TextArea data-chat-composer aria-label="chat composer" />
        <ImageLightbox />
      </>,
    );
    const opener = screen.getByRole('button', { name: 'image opener' });
    const composer = screen.getByRole('textbox', { name: 'chat composer' });
    opener.focus();
    act(() => {
      useImageLightboxStore.getState().open([
        { id: 'handoff-image', data: 'iVBORw0KGgo=', mediaType: 'image/png' },
      ], 0, opener);
    });
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: 'Image preview' })).toBeInTheDocument();
    });

    let resultPromise!: Promise<boolean>;
    act(() => {
      resultPromise = requestCapabilitySetup('chrome', {
        conversationId: 'conversation-focus-handoff',
        toolCallId: 'tool-focus-handoff',
        interactionMode: 'foreground',
      });
    });

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Image preview' })).not.toBeInTheDocument();
      expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);
    });
    await Promise.resolve();
    // Focus is on the first control of the page (Cancel), not on the corner button.
    const firstControl = within(screen.getByRole('dialog')).getAllByRole('button')[0];
    expect(firstControl).toHaveAccessibleName('cancel setup');
    expect(firstControl).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).not.toHaveFocus();
    expect(opener).not.toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'cancel setup' }));
    await expect(resultPromise).resolves.toBe(false);
    await waitFor(() => {
      expect(composer).toHaveFocus();
    });
  });

  it('gives focus back to whatever had it when the request arrived', async () => {
    renderWindow(
      <>
        <Button>send</Button>
        <TextArea data-chat-composer aria-label="chat composer" />
      </>,
    );
    const send = screen.getByRole('button', { name: 'send' });
    send.focus();

    let resultPromise!: Promise<boolean>;
    act(() => {
      resultPromise = requestFromTask().promise;
    });
    await screen.findByRole('dialog');
    await waitFor(() => expect(send).not.toHaveFocus());

    fireEvent.click(screen.getByRole('button', { name: 'cancel setup' }));
    await expect(resultPromise).resolves.toBe(false);
    await waitFor(() => expect(send).toHaveFocus());
  });

  // After a run of queued requests, focus goes back to where it was before the first one.
  it('gives focus back to the element that had it before the first of several queued requests', async () => {
    renderWindow(
      <>
        <Button>send</Button>
        <TextArea data-chat-composer aria-label="chat composer" />
      </>,
    );
    const send = screen.getByRole('button', { name: 'send' });
    send.focus();

    let first!: ReturnType<typeof requestFromTask>;
    let second!: ReturnType<typeof requestFromTask>;
    act(() => {
      first = requestFromTask('chrome', 'tool-first');
      second = requestFromTask('computer', 'tool-second');
    });
    await screen.findByRole('dialog', { name: 'Connect My Chrome' });
    fireEvent.click(screen.getByRole('button', { name: 'cancel setup' }));
    await expect(first.promise).resolves.toBe(false);

    const next = await screen.findByRole('dialog', { name: 'Enable Computer Use' });
    await waitFor(() => expect(next).toContainElement(document.activeElement as HTMLElement));
    fireEvent.click(screen.getByRole('button', { name: 'cancel setup' }));
    await expect(second.promise).resolves.toBe(false);

    await waitFor(() => expect(send).toHaveFocus());
    expect(screen.getByRole('textbox', { name: 'chat composer' })).not.toHaveFocus();
  });

  // Escape acts on the top layer, once. The window keeps no key listener of its own.
  it('is refused by one Escape, once, and a second Escape finds nothing to answer', async () => {
    const user = userEvent.setup();
    const { promise } = requestFromTask();
    renderWindow();
    await screen.findByRole('dialog', { name: 'Connect My Chrome' });

    await user.keyboard('{Escape}');
    await expect(promise).resolves.toBe(false);
    expect(resolveCapabilitySetup).toHaveBeenCalledTimes(1);

    await user.keyboard('{Escape}');
    expect(resolveCapabilitySetup).toHaveBeenCalledTimes(1);
  });

  it('holds Escape back from nobody: which layer takes the key is the layer registry\'s business', async () => {
    const { promise } = requestFromTask();
    renderWindow();
    await screen.findByRole('dialog', { name: 'Connect My Chrome' });
    const onDocument = vi.fn();
    document.addEventListener('keydown', onDocument);
    try {
      await userEvent.setup().keyboard('{Escape}');
      await expect(promise).resolves.toBe(false);
      expect(onDocument).toHaveBeenCalledTimes(1);
      expect(resolveCapabilitySetup).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', onDocument);
    }
  });

  // The close-window question as the app mounts it: `appModalOpen` is its switch, and it comes
  // after the grant window in the page.
  describe('with the close-window question', () => {
    const onQuit = vi.fn();
    const onMinimize = vi.fn();
    const onQuestionCancel = vi.fn();
    function CloseQuestion() {
      const open = usePreviewStore((s) => s.appModalOpen);
      return (
        <CloseDialog
          open={open}
          hasRunningAgent={false}
          onQuit={onQuit}
          onMinimize={onMinimize}
          onCancel={() => {
            usePreviewStore.getState().setAppModalOpen(false);
            onQuestionCancel();
          }}
          onCloseActionChange={() => undefined}
        />
      );
    }
    const renderBoth = () => render(<><CapabilitySetupDialog /><CloseQuestion /></>, { wrapper: DesignSystemProvider });
    const closeQuestion = () => screen.queryByRole('alertdialog', { name: 'Close Window' });
    // The grant window, found in the page: under the question it is out of the accessibility tree.
    const grantBox = () => Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))
      .find((box) => box.textContent?.includes('setup:')) ?? null;

    beforeEach(() => {
      onQuit.mockReset();
      onMinimize.mockReset();
      onQuestionCancel.mockReset();
      usePreviewStore.setState({ appModalOpen: false });
    });
    afterEach(() => { usePreviewStore.setState({ appModalOpen: false }); });

    it('stays on the page under the question, unanswered; one Escape closes the question alone and the second refuses the request', async () => {
      const user = userEvent.setup();
      const { promise, state } = requestFromTask();
      renderBoth();
      const dialog = await screen.findByRole('dialog', { name: 'Connect My Chrome' });
      const request = getPendingCapabilitySetup();

      act(() => usePreviewStore.setState({ appModalOpen: true }));
      expect(closeQuestion()).toBeInTheDocument();
      expect(grantBox()).toBe(dialog);
      expect(dialog).not.toHaveAttribute('hidden');
      expect(dialog).toHaveAttribute('data-state', 'open');
      expect(resolveCapabilitySetup).not.toHaveBeenCalled();
      expect(getPendingCapabilitySetup()).toBe(request);

      await user.keyboard('{Escape}');
      expect(onQuestionCancel).toHaveBeenCalledTimes(1);
      expect(closeQuestion()).toBeNull();
      expect(resolveCapabilitySetup).not.toHaveBeenCalled();
      expect(state.settled).toBe(false);
      expect(screen.getByRole('dialog', { name: 'Connect My Chrome' })).toBe(dialog);
      await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));

      await user.keyboard('{Escape}');
      await expect(promise).resolves.toBe(false);
      expect(resolveCapabilitySetup).toHaveBeenCalledTimes(1);
      expect(resolveCapabilitySetup).toHaveBeenCalledWith(request?.id, false);
      expect(onQuit).not.toHaveBeenCalled();
      expect(onMinimize).not.toHaveBeenCalled();
    });

    it('is not answered by the answers to the question', async () => {
      const user = userEvent.setup();
      const { state } = requestFromTask();
      renderBoth();
      await screen.findByRole('dialog', { name: 'Connect My Chrome' });

      act(() => usePreviewStore.setState({ appModalOpen: true }));
      // The question has been on the page long enough to be read.
      passSettleInterval();
      await user.click(screen.getByRole('button', { name: 'Minimize to Tray' }));
      await user.click(screen.getByRole('button', { name: 'Quit' }));

      expect(onMinimize).toHaveBeenCalledTimes(1);
      expect(onQuit).toHaveBeenCalledTimes(1);
      expect(resolveCapabilitySetup).not.toHaveBeenCalled();
      expect(state.settled).toBe(false);
    });

    it('takes the page from the question when its request arrives; the question is not cancelled and returns once the request is answered by its own button', async () => {
      renderBoth();
      act(() => usePreviewStore.setState({ appModalOpen: true }));
      const box = closeQuestion();
      expect(box).not.toBeNull();

      let request!: ReturnType<typeof requestFromTask>;
      act(() => { request = requestFromTask(); });
      const dialog = await screen.findByRole('dialog', { name: 'Connect My Chrome' });
      await waitFor(() => expect(within(dialog).getByRole('button', { name: 'cancel setup' })).toHaveFocus());
      expect(box).toHaveAttribute('hidden');
      expect(onQuestionCancel).not.toHaveBeenCalled();
      expect(usePreviewStore.getState().appModalOpen).toBe(true);
      expect(resolveCapabilitySetup).not.toHaveBeenCalled();

      fireEvent.click(within(dialog).getByRole('button', { name: 'cancel setup' }));
      await expect(request.promise).resolves.toBe(false);
      await waitFor(() => expect(closeQuestion()).toBe(box));
      expect(box).not.toHaveAttribute('hidden');
      expect(onQuestionCancel).not.toHaveBeenCalled();
      expect(onQuit).not.toHaveBeenCalled();
      expect(onMinimize).not.toHaveBeenCalled();
    });
  });

  it('opens with focus on the first control of the page, never on the one that completes setup', async () => {
    requestFromTask();
    renderWindow();

    const dialog = await screen.findByRole('dialog', { name: 'Connect My Chrome' });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'cancel setup' })).toHaveFocus());
    expect(within(dialog).getByRole('button', { name: 'complete setup' })).not.toHaveFocus();
    expect(within(dialog).getByRole('button', { name: 'Close' })).not.toHaveFocus();
  });

  // The window follows the request alone: nothing else in the app keeps it off the page.
  it('is on the page for as long as its request waits, whatever the image viewer and the close-window switch say', async () => {
    const { state } = requestFromTask();
    renderWindow();
    const dialog = await screen.findByRole('dialog', { name: 'Connect My Chrome' });

    act(() => {
      useImageLightboxStore.setState({ isOpen: true });
      usePreviewStore.setState({ appModalOpen: true });
    });
    expect(setupWindow()).toBe(dialog);
    expect(dialog).not.toHaveAttribute('hidden');
    expect(dialog).toHaveAttribute('data-state', 'open');
    expect(resolveCapabilitySetup).not.toHaveBeenCalled();
    expect(state.settled).toBe(false);
    act(() => {
      useImageLightboxStore.getState().close();
      usePreviewStore.setState({ appModalOpen: false });
    });
  });

  describe('one dialog at a time', () => {
    beforeEach(() => {
      useOtherDialog.setState({ open: false, dirty: false });
      useSettingsStore.setState({ systemSettingsOpen: false });
    });

    afterEach(() => {
      vi.useRealTimers();
      useOtherDialog.setState({ open: false, dirty: false });
      useSettingsStore.setState({ systemSettingsOpen: false });
    });

    it('turns away another dialog that opens while it is on screen: the request is not answered and focus stays in the window', async () => {
      const { state } = requestFromTask();
      renderWindow(
        <>
          <TextArea data-chat-composer aria-label="chat composer" />
          <OtherDialog />
        </>,
      );
      const dialog = await screen.findByRole('dialog', { name: 'Connect My Chrome' });
      const request = getPendingCapabilitySetup();
      vi.useFakeTimers();

      act(() => useOtherDialog.setState({ open: true }));
      await flushClose();

      expect(useOtherDialog.getState().open).toBe(false);
      expect(screen.queryByRole('dialog', { name: 'Other dialog' })).not.toBeInTheDocument();
      expect(resolveCapabilitySetup).not.toHaveBeenCalled();
      expect(state.settled).toBe(false);
      expect(getPendingCapabilitySetup()).toBe(request);
      expect(setupWindow()).toBe(dialog);
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    });

    it('keeps the request on screen and the one behind it waiting when another dialog opens; the next is shown once the first is answered', async () => {
      const first = requestFromTask('chrome', 'tool-first');
      const second = requestFromTask('computer', 'tool-second');
      renderWindow(<OtherDialog />);
      await screen.findByRole('dialog', { name: 'Connect My Chrome' });

      act(() => useOtherDialog.setState({ open: true }));

      expect(useOtherDialog.getState().open).toBe(false);
      expect(screen.getByRole('dialog', { name: 'Connect My Chrome' })).toBeInTheDocument();
      expect(resolveCapabilitySetup).not.toHaveBeenCalled();
      expect(first.state.settled).toBe(false);
      expect(second.state.settled).toBe(false);

      fireEvent.click(screen.getByRole('button', { name: 'cancel setup' }));
      await expect(first.promise).resolves.toBe(false);
      expect(await screen.findByRole('dialog', { name: 'Enable Computer Use' })).toBeInTheDocument();
      expect(screen.getAllByRole('dialog')).toHaveLength(1);
      expect(resolveCapabilitySetup).toHaveBeenCalledTimes(1);
      expect(second.state.settled).toBe(false);
    });

    describe('a request that arrives while a dialog holds unsaved input', () => {
      async function arriveOverUnsavedInput() {
        useOtherDialog.setState({ open: true, dirty: true });
        renderWindow(<OtherDialog />);
        await screen.findByRole('dialog', { name: 'Other dialog' });
        let first!: ReturnType<typeof requestFromTask>;
        let second!: ReturnType<typeof requestFromTask>;
        act(() => {
          first = requestFromTask('chrome', 'tool-first');
          second = requestFromTask('computer', 'tool-second');
        });
        expect(await screen.findByRole('alertdialog', { name: 'Discard these changes?' })).toBeInTheDocument();
        return { first, second };
      }

      it('waits, unanswered and not shown, while the user decides', async () => {
        const { first, second } = await arriveOverUnsavedInput();
        await Promise.resolve();

        expect(setupWindow()).not.toBeInTheDocument();
        expect(resolveCapabilitySetup).not.toHaveBeenCalled();
        expect(first.state.settled).toBe(false);
        expect(second.state.settled).toBe(false);
        expect(getPendingCapabilitySetup()?.id).toContain('tool-first');
      });

      it('shows its window after Discard, still unanswered', async () => {
        const { first, second } = await arriveOverUnsavedInput();

        fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

        expect(await screen.findByRole('dialog', { name: 'Connect My Chrome' })).toBeInTheDocument();
        expect(screen.queryByRole('dialog', { name: 'Other dialog' })).not.toBeInTheDocument();
        expect(useOtherDialog.getState().open).toBe(false);
        expect(resolveCapabilitySetup).not.toHaveBeenCalled();
        expect(first.state.settled).toBe(false);
        expect(second.state.settled).toBe(false);
      });

      it('goes on waiting, unanswered, after Keep editing, and is shown once that dialog has closed', async () => {
        const { first, second } = await arriveOverUnsavedInput();

        fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
        await Promise.resolve();

        expect(resolveCapabilitySetup).not.toHaveBeenCalled();
        expect(first.state.settled).toBe(false);
        expect(second.state.settled).toBe(false);
        expect(useOtherDialog.getState().open).toBe(true);
        expect(screen.getByRole('dialog', { name: 'Other dialog' })).toBeInTheDocument();
        // The question is not asked a second time, and the window is still off the page.
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
        expect(setupWindow()).not.toBeInTheDocument();
        expect(getPendingCapabilitySetup()?.id).toContain('tool-first');

        act(() => useOtherDialog.setState({ open: false, dirty: false }));

        expect(await screen.findByRole('dialog', { name: 'Connect My Chrome' })).toBeInTheDocument();
        expect(resolveCapabilitySetup).not.toHaveBeenCalled();
        expect(first.state.settled).toBe(false);
        expect(second.state.settled).toBe(false);
      });
    });

    describe('with another approval', () => {
      // A command approval as the chat view shows it: an approval layer of its own.
      const useCommandApproval = create(() => ({ open: false }));
      const onCommandAnswer = vi.fn();
      function CommandApproval() {
        const { open } = useCommandApproval();
        return (
          <Dialog
            open={open}
            onOpenChange={onCommandAnswer}
            layer="approval"
            role="alertdialog"
            outsidePress="ignore"
            title="Confirm Action"
            footer={<Button>Cancel the command</Button>}
          />
        );
      }
      const commandApproval = () => screen.queryByRole('alertdialog', { name: 'Confirm Action' });

      beforeEach(() => {
        onCommandAnswer.mockReset();
        useCommandApproval.setState({ open: false });
      });
      afterEach(() => { useCommandApproval.setState({ open: false }); });

      it('waits off the page, unanswered, behind a command approval that is on screen, and appears when that one is answered', async () => {
        useCommandApproval.setState({ open: true });
        renderWindow(<CommandApproval />);
        expect(commandApproval()).toBeInTheDocument();

        let request!: ReturnType<typeof requestFromTask>;
        act(() => { request = requestFromTask(); });
        await Promise.resolve();

        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(commandApproval()).toBeInTheDocument();
        expect(resolveCapabilitySetup).not.toHaveBeenCalled();
        expect(onCommandAnswer).not.toHaveBeenCalled();
        expect(request.state.settled).toBe(false);

        act(() => useCommandApproval.setState({ open: false }));

        expect(await screen.findByRole('dialog', { name: 'Connect My Chrome' })).toBeInTheDocument();
        expect(resolveCapabilitySetup).not.toHaveBeenCalled();
        expect(onCommandAnswer).not.toHaveBeenCalled();
        expect(request.state.settled).toBe(false);
      });

      it('is not answered by Escape while it waits behind a command approval: the key goes to the approval on screen', async () => {
        useCommandApproval.setState({ open: true });
        renderWindow(<CommandApproval />);
        let request!: ReturnType<typeof requestFromTask>;
        act(() => { request = requestFromTask(); });
        await Promise.resolve();

        await userEvent.setup().keyboard('{Escape}');

        expect(onCommandAnswer.mock.calls).toEqual([[false]]);
        expect(resolveCapabilitySetup).not.toHaveBeenCalled();
        expect(request.state.settled).toBe(false);
      });

      it('stays as it is when a command approval arrives; that approval waits off the page and neither is answered', async () => {
        const { state } = requestFromTask();
        renderWindow(<CommandApproval />);
        const dialog = await screen.findByRole('dialog', { name: 'Connect My Chrome' });
        const request = getPendingCapabilitySetup();

        act(() => useCommandApproval.setState({ open: true }));

        expect(setupWindow()).toBe(dialog);
        expect(dialog).not.toHaveAttribute('hidden');
        expect(document.querySelector('[role="alertdialog"]')).toBeNull();
        expect(resolveCapabilitySetup).not.toHaveBeenCalled();
        expect(onCommandAnswer).not.toHaveBeenCalled();
        expect(state.settled).toBe(false);
        expect(getPendingCapabilitySetup()).toBe(request);

        // The window is answered by its own button: the command approval takes its turn.
        fireEvent.click(screen.getByRole('button', { name: 'cancel setup' }));
        expect(await screen.findByRole('alertdialog', { name: 'Confirm Action' })).toBeInTheDocument();
        expect(resolveCapabilitySetup).toHaveBeenCalledTimes(1);
        expect(resolveCapabilitySetup).toHaveBeenCalledWith(request?.id, false);
        expect(onCommandAnswer).not.toHaveBeenCalled();
      });
    });

    describe('over the sign-in window while a sign-in is under way', () => {
      const cancelSignIn = vi.fn();
      const signInWindow = () => document.querySelector<HTMLElement>('[data-abu-account-dialog]');

      beforeEach(() => {
        cancelSignIn.mockReset();
        __resetAccountStoreForTest();
        useAccountStore.setState({ status: 'awaiting_browser', cancel: cancelSignIn });
        useSettingsStore.setState({ accountLoginOpen: true });
      });
      afterEach(() => {
        usePreviewStore.setState({ appModalOpen: false });
        useSettingsStore.setState({ accountLoginOpen: false });
        __resetAccountStoreForTest();
      });

      // The sign-in window comes before the grant window in the app, as here.
      it('has the sign-in window step aside and return; the sign-in is not cancelled and the request is answered only by its own button', async () => {
        renderWindow(<AccountLoginDialog />);
        const signIn = signInWindow();
        expect(signIn).not.toBeNull();

        let request!: ReturnType<typeof requestFromTask>;
        act(() => { request = requestFromTask(); });
        expect(await screen.findByRole('dialog', { name: 'Connect My Chrome' })).toBeInTheDocument();
        expect(signInWindow()).toBe(signIn);
        expect(signIn).toHaveAttribute('hidden');
        expect(cancelSignIn).not.toHaveBeenCalled();
        expect(resolveCapabilitySetup).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: 'cancel setup' }));
        await expect(request.promise).resolves.toBe(false);
        expect(signInWindow()).toBe(signIn);
        expect(signIn).not.toHaveAttribute('hidden');
        expect(cancelSignIn).not.toHaveBeenCalled();
        expect(useSettingsStore.getState().accountLoginOpen).toBe(true);
        expect(useAccountStore.getState().status).toBe('awaiting_browser');
      });

      it('keeps the sign-in and the request when the close-window question is asked over both and cancelled', async () => {
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
        const user = userEvent.setup();
        render(<><AccountLoginDialog /><CapabilitySetupDialog /><CloseQuestion /></>, { wrapper: DesignSystemProvider });
        const signIn = signInWindow();
        let request!: ReturnType<typeof requestFromTask>;
        act(() => { request = requestFromTask(); });
        const dialog = await screen.findByRole('dialog', { name: 'Connect My Chrome' });
        expect(signIn).toHaveAttribute('hidden');

        // The question stacks over the grant window; the sign-in window stays aside.
        act(() => usePreviewStore.setState({ appModalOpen: true }));
        expect(screen.getByRole('alertdialog', { name: 'Close Window' })).toBeInTheDocument();
        expect(dialog).not.toHaveAttribute('hidden');
        expect(signInWindow()).toBe(signIn);
        expect(signIn).toHaveAttribute('hidden');
        expect(cancelSignIn).not.toHaveBeenCalled();
        expect(resolveCapabilitySetup).not.toHaveBeenCalled();

        await user.keyboard('{Escape}');
        expect(onQuestionCancel).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('dialog', { name: 'Connect My Chrome' })).toBe(dialog);
        expect(signIn).toHaveAttribute('hidden');
        expect(cancelSignIn).not.toHaveBeenCalled();
        expect(resolveCapabilitySetup).not.toHaveBeenCalled();
        expect(request.state.settled).toBe(false);
        expect(useSettingsStore.getState().accountLoginOpen).toBe(true);

        fireEvent.click(screen.getByRole('button', { name: 'cancel setup' }));
        await expect(request.promise).resolves.toBe(false);
        expect(signInWindow()).toBe(signIn);
        expect(signIn).not.toHaveAttribute('hidden');
        expect(cancelSignIn).not.toHaveBeenCalled();
        expect(onQuit).not.toHaveBeenCalled();
        expect(useAccountStore.getState().status).toBe('awaiting_browser');
      });
    });

    it('closes the settings window when a task asks while it is open', async () => {
      useSettingsStore.setState({ systemSettingsOpen: true });
      renderWindow(<SystemSettingsDialog />);
      expect(await screen.findByRole('button', { name: 'a settings control' })).toBeInTheDocument();

      let request!: ReturnType<typeof requestFromTask>;
      act(() => { request = requestFromTask(); });

      const dialog = await screen.findByRole('dialog', { name: 'Connect My Chrome' });
      expect(useSettingsStore.getState().systemSettingsOpen).toBe(false);
      await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(1));
      expect(screen.queryByRole('button', { name: 'a settings control' })).not.toBeInTheDocument();
      await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
      expect(resolveCapabilitySetup).not.toHaveBeenCalled();
      expect(request.state.settled).toBe(false);
    });

    it('turns the settings window away when it is opened over it, and is not answered', async () => {
      const { state } = requestFromTask();
      renderWindow(<SystemSettingsDialog />);
      const dialog = await screen.findByRole('dialog', { name: 'Connect My Chrome' });

      act(() => useSettingsStore.getState().openSystemSettings());
      await Promise.resolve();

      expect(useSettingsStore.getState().systemSettingsOpen).toBe(false);
      expect(screen.queryByRole('button', { name: 'a settings control' })).not.toBeInTheDocument();
      expect(setupWindow()).toBe(dialog);
      expect(resolveCapabilitySetup).not.toHaveBeenCalled();
      expect(state.settled).toBe(false);
    });
  });

  it('stores a minimal recovery token before a task-requested relaunch', async () => {
    const taskSummaryHash = `sha256:${'a'.repeat(64)}`;
    const resultPromise = requestCapabilitySetup('computer', {
      conversationId: 'conversation-relaunch',
      toolCallId: 'tool-relaunch',
      interactionMode: 'foreground',
      taskSummaryHash,
    }, {
      computerUseRequirements: { screenRead: false, uiControl: true },
    });

    renderWindow();
    fireEvent.click(screen.getByRole('button', { name: 'restart setup' }));

    await expect(resultPromise).resolves.toBe(false);
    expect(restartAppMock).toHaveBeenCalledOnce();
    expect(JSON.parse(localStorage.getItem(
      'abu:computer-use-permission-resume:v1',
    ) ?? '{}')).toMatchObject({
      version: 1,
      conversationId: 'conversation-relaunch',
      taskSummaryHash,
      requirements: { screenRead: false, uiControl: true },
    });
  });
  describe('resume after relaunch when the pinned model is no longer usable', () => {
    let deleteSpy: MockInstance | undefined;

    afterEach(() => {
      deleteSpy?.mockRestore();
      deleteSpy = undefined;
      drainCapabilitySetupRequests();
      useToastStore.setState(useToastStore.getInitialState(), true);
      useSettingsStore.setState(useSettingsStore.getInitialState(), true);
      useEnterpriseStore.setState(useEnterpriseStore.getInitialState(), true);
      useChatStore.setState(useChatStore.getInitialState(), true);
    });

    it('does not rewind or re-run the task', async () => {
      vi.mocked(runAgentLoopDispatched).mockReset();
      useSettingsStore.setState(useSettingsStore.getInitialState(), true);
      useSettingsStore.setState((state) => ({
        providers: state.providers.map((provider) =>
          provider.id === 'anthropic' ? { ...provider, enabled: true, apiKey: 'test-key' } : provider,
        ),
      }));
      useEnterpriseStore.setState({ mode: { kind: 'personal' }, initialized: true });
      useToastStore.setState(useToastStore.getInitialState(), true);
      const messages = [{ id: 'user-1', role: 'user' as const, content: 'open the calculator', timestamp: 1, loopId: 'loop-1' }];
      useChatStore.setState({
        conversations: {
          'conversation-resume': {
            id: 'conversation-resume',
            title: 'resume',
            messages,
            createdAt: 1,
            updatedAt: 1,
            status: 'idle',
            model: { providerId: 'gone-provider', modelId: 'model-a' },
          },
        },
      });
      deleteSpy = vi.spyOn(useChatStore.getState(), 'deleteMessagesFrom');
      restoreComputerUseSetupRequest({
        conversationId: 'conversation-resume',
        taskSummaryHash: `sha256:${'b'.repeat(64)}`,
        requirements: { screenRead: false, uiControl: true },
      });

      renderWindow();
      fireEvent.click(screen.getByRole('button', { name: 'complete setup' }));

      await waitFor(() => expect(useToastStore.getState().toasts).toEqual([
        expect.objectContaining({ type: 'error', title: expect.stringContaining('model-a') }),
      ]));
      expect(deleteSpy).not.toHaveBeenCalled();
      expect(useChatStore.getState().conversations['conversation-resume'].messages).toBe(messages);
      expect(runAgentLoopDispatched).not.toHaveBeenCalled();
    });
  });
});
