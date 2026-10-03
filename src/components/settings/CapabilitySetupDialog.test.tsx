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
import CapabilitySetupDialog from './CapabilitySetupDialog';
import SystemSettingsDialog from './SystemSettingsDialog';
import { useImageLightboxStore } from '@/stores/imageLightboxStore';
import ImageLightbox from '@/components/chat/ImageLightbox';

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

  it('uses the first Escape to close a visible lightbox without denying setup', async () => {
    let settled = false;
    const resultPromise = requestCapabilitySetup('chrome', {
      conversationId: 'conversation-overlay',
      toolCallId: 'tool-overlay',
      interactionMode: 'foreground',
    }).finally(() => {
      settled = true;
    });
    useImageLightboxStore.getState().open([
      { id: 'image-1', data: 'cG5n', mediaType: 'image/png' },
    ], 0);

    renderWindow();
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(useImageLightboxStore.getState().isOpen).toBe(false);
    await Promise.resolve();
    expect(settled).toBe(false);

    fireEvent.keyDown(document, { key: 'Escape' });
    await expect(resultPromise).resolves.toBe(false);
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

  // A prompt under the window listens for Escape too; one key answers one thing.
  it('answers Escape itself and lets the key go no further', async () => {
    const { promise } = requestFromTask();
    renderWindow();
    await screen.findByRole('dialog', { name: 'Connect My Chrome' });
    const onDocument = vi.fn();
    const onWindow = vi.fn();
    document.addEventListener('keydown', onDocument);
    window.addEventListener('keydown', onWindow);
    try {
      await userEvent.setup().keyboard('{Escape}');

      await expect(promise).resolves.toBe(false);
      expect(resolveCapabilitySetup).toHaveBeenCalledTimes(1);
      expect(onDocument).not.toHaveBeenCalled();
      expect(onWindow).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', onDocument);
      window.removeEventListener('keydown', onWindow);
    }
  });

  describe('while the close-window question is open', () => {
    afterEach(() => { usePreviewStore.setState({ appModalOpen: false }); });

    it('steps aside unanswered, and comes back with focus on its first control', async () => {
      const { state } = requestFromTask();
      renderWindow();
      await screen.findByRole('dialog', { name: 'Connect My Chrome' });
      const request = getPendingCapabilitySetup();

      act(() => usePreviewStore.setState({ appModalOpen: true }));

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(resolveCapabilitySetup).not.toHaveBeenCalled();
      expect(state.settled).toBe(false);
      expect(getPendingCapabilitySetup()).toBe(request);

      act(() => usePreviewStore.setState({ appModalOpen: false }));

      const dialog = await screen.findByRole('dialog', { name: 'Connect My Chrome' });
      await waitFor(() => expect(within(dialog).getByRole('button', { name: 'cancel setup' })).toHaveFocus());
      expect(resolveCapabilitySetup).not.toHaveBeenCalled();
      expect(state.settled).toBe(false);
    });

    it('leaves Escape to the question: the request is not answered and the key travels on', async () => {
      const { state } = requestFromTask();
      act(() => usePreviewStore.setState({ appModalOpen: true }));
      renderWindow();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      const onWindow = vi.fn();
      window.addEventListener('keydown', onWindow);
      try {
        fireEvent.keyDown(document.body, { key: 'Escape' });

        expect(onWindow).toHaveBeenCalledTimes(1);
        expect(resolveCapabilitySetup).not.toHaveBeenCalled();
        expect(state.settled).toBe(false);
      } finally {
        window.removeEventListener('keydown', onWindow);
      }
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

  it('waits for an open image viewer: the first Escape closes the viewer, then the window appears', async () => {
    const { state } = requestFromTask();
    useImageLightboxStore.getState().open([
      { id: 'image-waiting', data: 'cG5n', mediaType: 'image/png' },
    ], 0);

    renderWindow();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(useImageLightboxStore.getState().isOpen).toBe(false);
    expect(await screen.findByRole('dialog', { name: 'Connect My Chrome' })).toBeInTheDocument();
    expect(resolveCapabilitySetup).not.toHaveBeenCalled();
    expect(state.settled).toBe(false);
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

    it('answers no when another dialog opens and takes its place, and leaves focus in that dialog', async () => {
      const { promise } = requestFromTask();
      renderWindow(
        <>
          <TextArea data-chat-composer aria-label="chat composer" />
          <OtherDialog />
        </>,
      );
      await screen.findByRole('dialog', { name: 'Connect My Chrome' });
      const id = getPendingCapabilitySetup()?.id;
      vi.useFakeTimers();

      act(() => useOtherDialog.setState({ open: true }));

      await expect(promise).resolves.toBe(false);
      expect(resolveCapabilitySetup).toHaveBeenCalledTimes(1);
      expect(resolveCapabilitySetup).toHaveBeenCalledWith(id, false);
      expect(setupWindow()).not.toBeInTheDocument();
      const other = screen.getByRole('dialog', { name: 'Other dialog' });
      await flushClose();
      expect(other).toContainElement(document.activeElement as HTMLElement);
      // The composer sits behind the other dialog, so it is hidden from the accessibility tree.
      expect(screen.getByRole('textbox', { name: 'chat composer', hidden: true })).not.toHaveFocus();
    });

    it('lets the next waiting request take over from the dialog that replaced the first one', async () => {
      const first = requestFromTask('chrome', 'tool-first');
      const second = requestFromTask('computer', 'tool-second');
      renderWindow(<OtherDialog />);
      await screen.findByRole('dialog', { name: 'Connect My Chrome' });

      act(() => useOtherDialog.setState({ open: true }));

      await expect(first.promise).resolves.toBe(false);
      expect(await screen.findByRole('dialog', { name: 'Enable Computer Use' })).toBeInTheDocument();
      expect(screen.getAllByRole('dialog')).toHaveLength(1);
      expect(useOtherDialog.getState().open).toBe(false);
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

      it('is refused by Keep editing, one request per decision', async () => {
        const { first, second } = await arriveOverUnsavedInput();

        fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));

        await expect(first.promise).resolves.toBe(false);
        expect(resolveCapabilitySetup).toHaveBeenCalledTimes(1);
        expect(resolveCapabilitySetup).toHaveBeenCalledWith(expect.stringContaining('tool-first'), false);
        expect(useOtherDialog.getState().open).toBe(true);
        // The next waiting request asks the same question; it is not refused along with the first.
        expect(await screen.findByRole('alertdialog', { name: 'Discard these changes?' })).toBeInTheDocument();
        expect(setupWindow()).not.toBeInTheDocument();
        expect(second.state.settled).toBe(false);
        expect(getPendingCapabilitySetup()?.id).toContain('tool-second');
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

    it('answers no when the settings window opens over it', async () => {
      const { promise } = requestFromTask();
      renderWindow(<SystemSettingsDialog />);
      await screen.findByRole('dialog', { name: 'Connect My Chrome' });

      act(() => useSettingsStore.getState().openSystemSettings());

      await expect(promise).resolves.toBe(false);
      expect(setupWindow()).not.toBeInTheDocument();
      expect(useSettingsStore.getState().systemSettingsOpen).toBe(true);
      expect(await screen.findByRole('button', { name: 'a settings control' })).toBeInTheDocument();
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
