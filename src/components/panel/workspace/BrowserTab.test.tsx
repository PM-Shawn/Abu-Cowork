// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BrowserTab from './BrowserTab';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useImageLightboxStore } from '@/stores/imageLightboxStore';
import * as approvalBridge from '@/core/agent/ports/approvalBridge';
import {
  drainCapabilitySetupRequests,
  getPendingCapabilitySetup,
  requestCapabilitySetup,
  resolveCapabilitySetup,
} from '@/core/capabilityPlugins/setupBridge';
import { DesignSystemProvider } from '@/components/ds/provider';

const invoke = vi.fn();
const listen = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listen(...args),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(),
}));
vi.mock('@/utils/platform', () => ({
  isMacOS: () => true,
}));

function renderTab(tabId: string, url: string) {
  return render(
    <DesignSystemProvider>
      <BrowserTab tabId={tabId} url={url} />
    </DesignSystemProvider>,
  );
}

describe('BrowserTab native overlay visibility', () => {
  beforeEach(() => {
    const runtime = globalThis as typeof globalThis & {
      __ABU_SHELL__?: unknown;
      __TAURI_INTERNALS__?: unknown;
    };
    delete runtime.__ABU_SHELL__;
    // BrowserTab's native bridge is desktop-only. Mirror the preload marker
    // that both packaged hosts expose so these tests exercise that path.
    runtime.__TAURI_INTERNALS__ = {};
    initLanguage('en-US');
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    listen.mockReset();
    listen.mockResolvedValue(() => {});
    approvalBridge.drainAll('command');
    approvalBridge.drainAll('file-permission');
    approvalBridge.drainAll('workspace');
    drainCapabilitySetupRequests();
    useChatStore.setState({ activeConversationId: 'active-conversation' });
    useSettingsStore.setState({ systemSettingsOpen: false });
    usePreviewStore.setState({ menuOpen: false });
    useImageLightboxStore.getState().close();

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 500,
      height: 400,
      left: 100,
      right: 700,
      top: 100,
      width: 600,
      x: 100,
      y: 100,
      toJSON: () => ({}),
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
      configurable: true,
      get: () => document.body,
    });
  });

  afterEach(() => {
    const runtime = globalThis as typeof globalThis & {
      __ABU_SHELL__?: unknown;
      __TAURI_INTERNALS__?: unknown;
    };
    delete runtime.__ABU_SHELL__;
    delete runtime.__TAURI_INTERNALS__;
    approvalBridge.drainAll('command');
    approvalBridge.drainAll('file-permission');
    approvalBridge.drainAll('workspace');
    drainCapabilitySetupRequests();
    useImageLightboxStore.getState().close();
    cleanup();
    vi.restoreAllMocks();
  });

  it('restores a failed handover as retryable failure instead of human control', async () => {
    invoke.mockImplementation(async (command) => command === 'browser_control' ? 'yield-failed' : undefined);
    const { getByRole } = render(<DesignSystemProvider><BrowserTab tabId="failed-handoff" url="https://example.com/" /></DesignSystemProvider>);
    await waitFor(() => expect(getByRole('alert')).toHaveTextContent('Could not change control'));
    expect(getByRole('button', { name: 'Take control' })).toBeEnabled();
  });

  it('keeps the document while taking and returning control through the host', async () => {
    invoke.mockImplementation(async (command, args) => command === 'browser_control' ? (args.action === 'take' ? 'human' : 'ai') : undefined);
    const { getByRole } = render(<DesignSystemProvider><BrowserTab tabId="handoff" url="https://example.com/" /></DesignSystemProvider>);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('browser_control', { id: 'handoff' }));
    const before = invoke.mock.calls.filter(([command]) => ['browser_create', 'browser_navigate', 'browser_reload'].includes(command)).length;
    fireEvent.click(getByRole('button', { name: 'Take control' }));
    await waitFor(() => expect(getByRole('button', { name: 'Hand back to Abu' })).toBeEnabled());
    expect(getByRole('status')).toHaveTextContent('You are in control');
    fireEvent.click(getByRole('button', { name: 'Hand back to Abu' }));
    await waitFor(() => expect(getByRole('button', { name: 'Take control' })).toBeEnabled());
    expect(invoke.mock.calls.filter(([command]) => ['browser_create', 'browser_navigate', 'browser_reload'].includes(command))).toHaveLength(before);
  });

  it('shows and dismisses a host-reported blocked popup without replaying navigation', async () => {
    const { getByRole, queryByRole } = render(<DesignSystemProvider><BrowserTab tabId="popup-notice" url="https://example.com/" /></DesignSystemProvider>);
    await waitFor(() => expect(listen).toHaveBeenCalledWith('browser://popup-blocked/popup-notice', expect.any(Function)));
    const handler = listen.mock.calls.find(([event]) => event === 'browser://popup-blocked/popup-notice')![1] as () => void;
    const priorNavigations = invoke.mock.calls.filter(([command]) => command === 'browser_navigate').length;
    act(handler);
    expect(getByRole('status')).toHaveTextContent('Popup blocked');
    fireEvent.click(getByRole('button', { name: 'Dismiss hint' }));
    expect(queryByRole('status')).toBeNull();
    expect(invoke.mock.calls.filter(([command]) => command === 'browser_navigate')).toHaveLength(priorNavigations);
  });

  it('hides the native view for an active-conversation approval and restores it afterwards', async () => {
    render(
      <DesignSystemProvider>
        <BrowserTab
          tabId="browser-approval-regression"
          url="https://example.com"
        />
      </DesignSystemProvider>,
    );

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_create', expect.objectContaining({
        id: 'browser-approval-regression',
      }));
    });
    invoke.mockClear();

    let approvalPromise: Promise<boolean>;
    act(() => {
      approvalPromise = approvalBridge.request('command', {
        conversationId: 'active-conversation',
        payload: {
          info: {
            command: 'rm -- test-file',
            level: 'warn',
            reason: 'Regression test',
          },
        },
      });
    });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_hide', {
        id: 'browser-approval-regression',
      });
    });

    invoke.mockClear();
    act(() => {
      approvalBridge.resolveActive('command', false);
    });

    await expect(approvalPromise!).resolves.toBe(false);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_show', {
        id: 'browser-approval-regression',
      });
    });
  });

  it('hides the native view while the image lightbox is open and restores it on close', async () => {
    render(
      <DesignSystemProvider>
        <BrowserTab
          tabId="browser-image-lightbox"
          url="https://example.com"
        />
      </DesignSystemProvider>,
    );

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_create', expect.objectContaining({
        id: 'browser-image-lightbox',
      }));
    });
    invoke.mockClear();

    act(() => {
      useImageLightboxStore.getState().open([
        { id: 'image-1', data: 'cG5n', mediaType: 'image/png' },
      ], 0);
    });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_hide', { id: 'browser-image-lightbox' });
    });
    expect(invoke).not.toHaveBeenCalledWith('browser_capture', expect.anything());
    invoke.mockClear();

    act(() => {
      useImageLightboxStore.getState().close();
    });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_show', { id: 'browser-image-lightbox' });
    });
  });

  it('immediately hides for the lightbox while an older overlay capture is pending', async () => {
    let resolveCapture!: (value: string | null) => void;
    const capturePending = new Promise<string | null>((resolve) => {
      resolveCapture = resolve;
    });
    invoke.mockImplementation((command: string) => (
      command === 'browser_capture' ? capturePending : Promise.resolve(undefined)
    ));

    render(
      <DesignSystemProvider>
        <BrowserTab
          tabId="browser-lightbox-capture-handoff"
          url="https://example.com"
        />
      </DesignSystemProvider>,
    );
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_create', expect.objectContaining({
        id: 'browser-lightbox-capture-handoff',
      }));
    });
    invoke.mockClear();

    act(() => {
      usePreviewStore.setState({ menuOpen: true });
    });
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_capture', {
        id: 'browser-lightbox-capture-handoff',
      });
    });

    act(() => {
      useImageLightboxStore.getState().open([
        { id: 'handoff-image', data: 'cG5n', mediaType: 'image/png' },
      ], 0);
    });
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_hide', {
        id: 'browser-lightbox-capture-handoff',
      });
    });

    // Closing both overlays must restore the native view without waiting for
    // the obsolete capture promise to settle.
    await act(async () => {
      await Promise.resolve();
    });
    invoke.mockClear();
    act(() => {
      useImageLightboxStore.getState().close();
      usePreviewStore.setState({ menuOpen: false });
    });
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_show', {
        id: 'browser-lightbox-capture-handoff',
      });
    });

    await act(async () => {
      resolveCapture(null);
      await capturePending;
    });
  });

  it('creates an Electron native view hidden when the lightbox is already open', async () => {
    const runtime = globalThis as typeof globalThis & {
      __ABU_SHELL__?: { mainSupervisesSidecar?: boolean };
    };
    runtime.__ABU_SHELL__ = { mainSupervisesSidecar: true };
    act(() => {
      useImageLightboxStore.getState().open([
        { id: 'image-before-browser', data: 'cG5n', mediaType: 'image/png' },
      ], 0);
    });

    render(
      <DesignSystemProvider>
        <BrowserTab
          tabId="browser-created-under-lightbox"
          url="https://example.com"
        />
      </DesignSystemProvider>,
    );

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_create', expect.objectContaining({
        id: 'browser-created-under-lightbox',
        visible: false,
      }));
    });
  });

  it('opens a toolbar tooltip upward (away from the native view) without ever hiding it', async () => {
    // Regression guard for a prior fix attempt: hiding the native webview on
    // every tooltip hover (mirroring the click-menu `menuOpen` gate) stopped
    // the tooltip from being clipped, but caused a visible flash on every
    // hover since tooltips fire far more often than menu opens. The actual
    // fix renders the tooltip upward (`side="top"`) so it never overlaps the
    // native view's rect in the first place — no hide/show needed at all.
    const view = render(
      <DesignSystemProvider>
        <BrowserTab
          tabId="browser-toolbar-tooltip"
          url="https://example.com"
        />
      </DesignSystemProvider>,
    );

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_create', expect.objectContaining({
        id: 'browser-toolbar-tooltip',
      }));
    });
    invoke.mockClear();

    // Every toolbar tooltip, not only the first: each one sits above the native view.
    for (const name of ['Back', 'Forward', 'Reload', 'Open in system browser', 'Select element']) {
      const button = view.getByRole('button', { name });
      // A design-system tooltip opens at once on keyboard focus.
      act(() => button.focus());
      const tooltip = await view.findByRole('tooltip', { name });
      expect(tooltip.closest('[data-side]')).toHaveAttribute('data-side', 'top');
      act(() => button.blur());
      await waitFor(() => {
        expect(view.queryByRole('tooltip', { name })).not.toBeInTheDocument();
      });
    }

    expect(invoke).not.toHaveBeenCalledWith('browser_hide', expect.anything());
    expect(invoke).not.toHaveBeenCalledWith('browser_show', expect.anything());
  });

  it('hides the native view for task-local capability setup and restores it afterwards', async () => {
    render(
      <DesignSystemProvider>
        <BrowserTab
          tabId="browser-capability-setup"
          url="https://example.com"
        />
      </DesignSystemProvider>,
    );

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_create', expect.objectContaining({
        id: 'browser-capability-setup',
      }));
    });
    invoke.mockClear();

    let setupPromise: Promise<boolean>;
    act(() => {
      setupPromise = requestCapabilitySetup('computer', {
        conversationId: 'background-conversation',
        toolCallId: 'computer-tool',
        interactionMode: 'foreground',
      });
    });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_hide', {
        id: 'browser-capability-setup',
      });
    });

    invoke.mockClear();
    act(() => {
      resolveCapabilitySetup(getPendingCapabilitySetup()!.id, false);
    });

    await expect(setupPromise!).resolves.toBe(false);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_show', {
        id: 'browser-capability-setup',
      });
    });
  });

  it('hides again after browser creation completes during an approval', async () => {
    let resolveCreate!: () => void;
    const createPending = new Promise<void>((resolve) => {
      resolveCreate = resolve;
    });
    invoke.mockImplementation((command: string) => (
      command === 'browser_create' ? createPending : Promise.resolve(undefined)
    ));

    render(
      <DesignSystemProvider>
        <BrowserTab
          tabId="browser-create-approval-race"
          url="https://example.com"
        />
      </DesignSystemProvider>,
    );
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_create', expect.anything());
    });

    let approvalPromise: Promise<boolean>;
    act(() => {
      approvalPromise = approvalBridge.request('command', {
        conversationId: 'active-conversation',
        payload: {
          info: {
            command: 'rm -- race-test',
            level: 'warn',
            reason: 'Race regression test',
          },
        },
      });
    });

    await waitFor(() => {
      expect(invoke.mock.calls.filter(([command]) => command === 'browser_hide').length)
        .toBeGreaterThan(0);
    });
    const hidesBeforeCreate = invoke.mock.calls.filter(
      ([command]) => command === 'browser_hide',
    ).length;

    await act(async () => {
      resolveCreate();
      await createPending;
    });
    expect(invoke.mock.calls.filter(([command]) => command === 'browser_hide').length)
      .toBeGreaterThanOrEqual(hidesBeforeCreate);

    act(() => {
      approvalBridge.resolveActive('command', false);
    });
    await expect(approvalPromise!).resolves.toBe(false);
  });

  it('creates an Electron native view hidden when setup is already open', async () => {
    const runtime = globalThis as typeof globalThis & {
      __ABU_SHELL__?: { mainSupervisesSidecar?: boolean };
    };
    runtime.__ABU_SHELL__ = { mainSupervisesSidecar: true };
    const setupPromise = requestCapabilitySetup('computer', {
      conversationId: 'active-conversation',
      toolCallId: 'setup-before-browser',
      interactionMode: 'foreground',
    });

    render(
      <DesignSystemProvider>
        <BrowserTab
          tabId="browser-created-under-setup"
          url="https://example.com"
        />
      </DesignSystemProvider>,
    );

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_create', expect.objectContaining({
        id: 'browser-created-under-setup',
        visible: false,
      }));
    });
    expect(invoke.mock.calls.some(([command]) => command === 'browser_hide')).toBe(false);

    act(() => {
      resolveCapabilitySetup(getPendingCapabilitySetup()!.id, false);
    });
    await expect(setupPromise).resolves.toBe(false);
    delete runtime.__ABU_SHELL__;
  });

  it('retries a failed native hide instead of treating the view as hidden', async () => {
    render(
      <DesignSystemProvider>
        <BrowserTab
          tabId="browser-hide-retry"
          url="https://example.com"
        />
      </DesignSystemProvider>,
    );
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_create', expect.anything());
    });

    let hideAttempts = 0;
    invoke.mockImplementation((command: string) => {
      if (command === 'browser_hide' && hideAttempts++ === 0) {
        return Promise.reject(new Error('transient IPC failure'));
      }
      return Promise.resolve(undefined);
    });

    let approvalPromise: Promise<boolean>;
    act(() => {
      approvalPromise = approvalBridge.request('command', {
        conversationId: 'active-conversation',
        payload: {
          info: {
            command: 'rm -- retry-test',
            level: 'warn',
            reason: 'Retry regression test',
          },
        },
      });
    });

    await waitFor(() => {
      expect(hideAttempts).toBeGreaterThanOrEqual(2);
    });

    act(() => {
      approvalBridge.resolveActive('command', false);
    });
    await expect(approvalPromise!).resolves.toBe(false);
  });

  it('retries browser creation after a transient IPC failure', async () => {
    let createAttempts = 0;
    invoke.mockImplementation((command: string) => {
      if (command === 'browser_create' && createAttempts++ === 0) {
        return Promise.reject(new Error('transient create failure'));
      }
      return Promise.resolve(undefined);
    });

    render(
      <DesignSystemProvider>
        <BrowserTab
          tabId="browser-create-retry"
          url="https://example.com"
        />
      </DesignSystemProvider>,
    );

    await waitFor(() => {
      expect(createAttempts).toBeGreaterThanOrEqual(2);
    });
  });

  it('cancels an old create retry when the user commits a newer URL', async () => {
    vi.useFakeTimers();
    let firstCreate = true;
    invoke.mockImplementation((command: string) => {
      if (command === 'browser_create' && firstCreate) {
        firstCreate = false;
        return Promise.reject(new Error('transient create failure'));
      }
      return Promise.resolve(undefined);
    });

    const view = render(
      <DesignSystemProvider>
        <BrowserTab
          tabId="browser-create-retry-latest-url"
          url="https://old.example.com"
        />
      </DesignSystemProvider>,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const address = view.getByRole('textbox');
    fireEvent.change(address, { target: { value: 'https://new.example.com' } });
    fireEvent.keyDown(address, { key: 'Enter' });
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_000);
    });

    const navigationCalls = invoke.mock.calls.filter(
      ([command]) => command === 'browser_create' || command === 'browser_navigate',
    );
    expect(navigationCalls.filter(([, args]) => args.url === 'https://old.example.com'))
      .toHaveLength(1);
    expect(navigationCalls.at(-1)).toEqual([
      'browser_create',
      expect.objectContaining({ url: 'https://new.example.com' }),
    ]);

    view.unmount();
    vi.useRealTimers();
  });

  // Regression: an agent-adopted tab is created in the BACKGROUND, so its
  // placeholder hangs under a `display:none` ancestor and reports an all-zero
  // rect. Clamping that to 1×1 produced a real 1×1 webview — the page laid out
  // at one pixel, and `syncBounds` returns early while the tab is invisible, so
  // nothing corrected it until the user switched to the tab.
  it('creates a hidden (background-adopted) tab at a usable default size, not 1×1', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0,
      toJSON: () => ({}),
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
      configurable: true,
      get: () => null,
    });

    render(
      <DesignSystemProvider>
        <BrowserTab tabId="browser-adopted-hidden" url="https://example.com" />
      </DesignSystemProvider>,
    );

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_create', expect.objectContaining({
        id: 'browser-adopted-hidden',
      }));
    });
    const createArgs = invoke.mock.calls.find(([command]) => command === 'browser_create')![1];
    // Matches browserHost.cjs's own headless fallback size.
    expect(createArgs).toMatchObject({ width: 1024, height: 768 });
  });

  it('still creates a visible tab at its real rect (the fallback never overrides a laid-out placeholder)', async () => {
    render(
      <DesignSystemProvider>
        <BrowserTab tabId="browser-visible-rect" url="https://example.com" />
      </DesignSystemProvider>,
    );

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_create', expect.objectContaining({
        id: 'browser-visible-rect',
      }));
    });
    const createArgs = invoke.mock.calls.find(([command]) => command === 'browser_create')![1];
    // The beforeEach rect: 600×400 at (100, 100).
    expect(createArgs).toMatchObject({ x: 100, y: 100, width: 600, height: 400 });
  });

  it('hides the native view on unmount instead of destroying it', async () => {
    const { unmount } = render(
      <DesignSystemProvider>
        <BrowserTab tabId="browser-unmount-keepalive" url="https://example.com" />
      </DesignSystemProvider>,
    );

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_create', expect.objectContaining({
        id: 'browser-unmount-keepalive',
      }));
    });
    invoke.mockClear();

    unmount();

    // The view outlives this component — only the tab record (previewStore)
    // may destroy it.
    expect(invoke).toHaveBeenCalledWith('browser_hide', { id: 'browser-unmount-keepalive' });
    expect(invoke).not.toHaveBeenCalledWith('browser_close', expect.anything());
  });

  // N3: address-bar focus/typing and back/forward/reload clicks all live in
  // this MAIN-window React layer, never touching the guest webContents that
  // the takeover backoff (R4, electron/browserHost.cjs) listens on — so using
  // them was invisible to the backoff. `browser_note_user_interaction`
  // bridges that gap; these tests pin the renderer side of the wiring.
  describe('N3 — React-layer takeover signal (browser_note_user_interaction)', () => {
    async function renderReadyTab(tabId: string) {
      const view = render(
        <DesignSystemProvider>
          <BrowserTab tabId={tabId} url="https://example.com" />
        </DesignSystemProvider>,
      );
      await waitFor(() => {
        expect(invoke).toHaveBeenCalledWith('browser_create', expect.objectContaining({ id: tabId }));
      });
      invoke.mockClear();
      return view;
    }

    it('notes user interaction when the address bar receives focus', async () => {
      const { getByPlaceholderText } = await renderReadyTab('browser-n3-focus');

      fireEvent.focus(getByPlaceholderText('Enter a URL or search'));

      expect(invoke).toHaveBeenCalledWith('browser_note_user_interaction', { id: 'browser-n3-focus' });
    });

    it('notes user interaction on address-bar input, throttled to one call per window', async () => {
      // waitFor's internal polling needs real timers, so render (and its
      // waitFor inside renderReadyTab) happens first; fake time is only
      // frozen afterwards, for the throttle-window assertions below. Mirrors
      // the nav-buttons test above — real timers here let a slow/loaded CI
      // box spend real wall-clock time on the typing storm and blow past the
      // 500ms window, which is exactly the flake this pins down.
      const { getByPlaceholderText } = await renderReadyTab('browser-n3-typing');
      const input = getByPlaceholderText('Enter a URL or search');

      vi.useFakeTimers();
      try {
        const fixedNow = new Date('2026-01-01T00:00:00.000Z');
        vi.setSystemTime(fixedNow);

        // A typing storm: many changes fired back-to-back, well inside the
        // 500ms throttle window (frozen, so this can never flake).
        for (const ch of ['h', 'ht', 'htt', 'http', 'https']) {
          fireEvent.change(input, { target: { value: ch } });
        }

        let noteCalls = invoke.mock.calls.filter(([command]) => command === 'browser_note_user_interaction');
        expect(noteCalls).toHaveLength(1);
        expect(noteCalls[0][1]).toEqual({ id: 'browser-n3-typing' });

        // Past the throttle window: the next change is allowed through,
        // pinning window-expiry behavior alongside suppression.
        invoke.mockClear();
        vi.setSystemTime(new Date(fixedNow.getTime() + 501));
        fireEvent.change(input, { target: { value: 'https://' } });

        noteCalls = invoke.mock.calls.filter(([command]) => command === 'browser_note_user_interaction');
        expect(noteCalls).toHaveLength(1);
        expect(noteCalls[0][1]).toEqual({ id: 'browser-n3-typing' });
      } finally {
        vi.useRealTimers();
      }
    });

    it('notes user interaction on back/forward/reload button clicks', async () => {
      // waitFor's internal polling needs real timers, so render (and its
      // waitFor above) happens first; fake time is only frozen afterwards,
      // for the throttle-window assertions below.
      const { container } = await renderReadyTab('browser-n3-navbuttons');
      vi.useFakeTimers();
      try {
        const fixedNow = new Date('2026-01-01T00:00:00.000Z');
        vi.setSystemTime(fixedNow);
        const [backButton, forwardButton, reloadButton] = container.querySelectorAll('button');

        fireEvent.click(backButton);
        expect(invoke).toHaveBeenCalledWith('browser_note_user_interaction', { id: 'browser-n3-navbuttons' });
        expect(invoke).toHaveBeenCalledWith('browser_back', { id: 'browser-n3-navbuttons' });

        // Past the throttle window so forward/reload each independently note it.
        invoke.mockClear();
        vi.setSystemTime(new Date(fixedNow.getTime() + 1000));
        fireEvent.click(forwardButton);
        expect(invoke).toHaveBeenCalledWith('browser_note_user_interaction', { id: 'browser-n3-navbuttons' });

        invoke.mockClear();
        vi.setSystemTime(new Date(fixedNow.getTime() + 2000));
        fireEvent.click(reloadButton);
        expect(invoke).toHaveBeenCalledWith('browser_note_user_interaction', { id: 'browser-n3-navbuttons' });
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not gate browser_navigate itself — the renderer path stays un-gated for the user', async () => {
      const { getByPlaceholderText } = await renderReadyTab('browser-n3-navigate-ungated');
      const input = getByPlaceholderText('Enter a URL or search');

      fireEvent.change(input, { target: { value: 'https://new.example.com' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      await waitFor(() => {
        expect(invoke).toHaveBeenCalledWith('browser_navigate', expect.objectContaining({
          id: 'browser-n3-navigate-ungated',
          url: 'https://new.example.com',
        }));
      });
    });
  });

  // Real-device acceptance (2026-09-01, G6/G7): the user typed into the address
  // bar without pressing Enter; the agent's resumed programmatic navigation
  // fired a `browser://nav/*` event, which unconditionally rewrote the bound
  // input value and silently wiped the draft. The address bar must not follow
  // programmatic URL updates while the user is editing it.
  describe('address bar draft protection', () => {
    const navHandlers = new Map<string, (event: { payload: string }) => void>();

    async function renderTabWithNav(tabId: string) {
      navHandlers.clear();
      listen.mockImplementation((event: string, handler: (e: { payload: string }) => void) => {
        navHandlers.set(event, handler);
        return Promise.resolve(() => {});
      });
      const view = render(
        <DesignSystemProvider>
          <BrowserTab tabId={tabId} url="https://example.com" />
        </DesignSystemProvider>,
      );
      await waitFor(() => {
        expect(invoke).toHaveBeenCalledWith('browser_create', expect.objectContaining({ id: tabId }));
      });
      await waitFor(() => {
        expect(navHandlers.has(`browser://nav/${tabId}`)).toBe(true);
      });
      const fireNav = (url: string) => {
        act(() => {
          navHandlers.get(`browser://nav/${tabId}`)!({ payload: url });
        });
      };
      const input = view.getByPlaceholderText('Enter a URL or search') as HTMLInputElement;
      return { view, input, fireNav };
    }

    it('follows programmatic navigation while the address bar is untouched', async () => {
      const { input, fireNav } = await renderTabWithNav('browser-draft-follow');

      fireNav('https://agent-went-here.example.com/page');

      expect(input.value).toBe('https://agent-went-here.example.com/page');
    });

    it('keeps a focused draft when a programmatic navigation updates the tab URL', async () => {
      const { input, fireNav } = await renderTabWithNav('browser-draft-focused');

      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: 'weather tomor' } });
      fireNav('https://agent-went-here.example.com/page');

      expect(input.value).toBe('weather tomor');
    });

    it('keeps a blurred draft that was never committed', async () => {
      const { input, fireNav } = await renderTabWithNav('browser-draft-blurred');

      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: 'half-typed query' } });
      fireEvent.blur(input);
      fireNav('https://agent-went-here.example.com/page');

      expect(input.value).toBe('half-typed query');
    });

    it('protects a clean focused input, then resyncs to the latest URL on blur', async () => {
      const { input, fireNav } = await renderTabWithNav('browser-draft-clean-focus');

      fireEvent.focus(input);
      fireNav('https://agent-went-here.example.com/page');
      // Still showing what the user was looking at while focused…
      expect(input.value).toBe('https://example.com');

      fireEvent.blur(input);
      // …and following again once they leave without edits.
      expect(input.value).toBe('https://agent-went-here.example.com/page');
    });

    it('resyncs an emptied draft to the current URL on blur', async () => {
      const { input, fireNav } = await renderTabWithNav('browser-draft-emptied');

      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: '' } });
      fireNav('https://agent-went-here.example.com/page');
      fireEvent.blur(input);

      expect(input.value).toBe('https://agent-went-here.example.com/page');
      fireNav('https://agent-next.example.com/');
      expect(input.value).toBe('https://agent-next.example.com/');
    });

    it('reverts the draft to the current page URL on Escape and resumes following', async () => {
      const { input, fireNav } = await renderTabWithNav('browser-draft-escape');

      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: 'abandoned draft' } });
      fireNav('https://agent-went-here.example.com/page');
      fireEvent.keyDown(input, { key: 'Escape' });

      expect(input.value).toBe('https://agent-went-here.example.com/page');

      fireEvent.blur(input);
      fireNav('https://agent-next.example.com/');
      expect(input.value).toBe('https://agent-next.example.com/');
    });

    it('committing a draft with Enter clears protection so navigation follows again', async () => {
      const { input, fireNav } = await renderTabWithNav('browser-draft-commit');

      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: 'https://typed.example.com' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.blur(input);

      fireNav('https://redirected.example.com/landing');
      expect(input.value).toBe('https://redirected.example.com/landing');
    });

    it('still records the programmatic navigation as the committed URL while a draft is held', async () => {
      const { input, fireNav } = await renderTabWithNav('browser-draft-committed-url');

      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: 'draft in progress' } });
      fireNav('https://agent-went-here.example.com/page');
      expect(input.value).toBe('draft in progress');

      // Escape reveals the committed URL the tab actually tracked underneath.
      fireEvent.keyDown(input, { key: 'Escape' });
      expect(input.value).toBe('https://agent-went-here.example.com/page');
    });
  });

  describe('toolbar', () => {
    const TOOLBAR_NAMES = ['Back', 'Forward', 'Reload', 'Open in system browser', 'Select element'];

    async function renderLoadedTab(tabId: string) {
      const view = renderTab(tabId, 'https://example.com');
      await waitFor(() => {
        expect(invoke).toHaveBeenCalledWith('browser_create', expect.objectContaining({ id: tabId }));
      });
      return view;
    }

    it('names the five icon buttons and keeps back, forward and reload first', async () => {
      const view = await renderLoadedTab('browser-toolbar-names');

      for (const name of TOOLBAR_NAMES) {
        const button = view.getByRole('button', { name });
        expect(button).toBeEnabled();
        // The name comes from the button itself; a native title would add a second tooltip.
        expect(button).not.toHaveAttribute('title');
      }
      const [first, second, third] = view.container.querySelectorAll('button');
      expect(first).toHaveAccessibleName('Back');
      expect(second).toHaveAccessibleName('Forward');
      expect(third).toHaveAccessibleName('Reload');
    });

    it('keeps the names of the disabled buttons of an empty tab', () => {
      const view = renderTab('browser-toolbar-empty', '');

      for (const name of TOOLBAR_NAMES) {
        expect(view.getByRole('button', { name })).toBeDisabled();
      }
      expect(view.getByRole('button', { name: 'Take control' })).toBeDisabled();
    });

    it('marks the element picker as pressed while it is on', async () => {
      const view = await renderLoadedTab('browser-toolbar-inspect');
      const picker = view.getByRole('button', { name: 'Select element' });
      expect(picker).toHaveAttribute('aria-pressed', 'false');

      fireEvent.click(picker);

      await waitFor(() => expect(picker).toHaveAttribute('aria-pressed', 'true'));
      expect(invoke).toHaveBeenCalledWith('browser_inspect_set', expect.objectContaining({
        id: 'browser-toolbar-inspect',
        enabled: true,
      }));

      fireEvent.click(picker);
      await waitFor(() => expect(picker).toHaveAttribute('aria-pressed', 'false'));
    });

    it('hands the element picker the design-system colours', async () => {
      const root = document.documentElement;
      const tokens: Record<string, string> = {
        '--ds-raised': 'rgb(1, 1, 1)',
        '--ds-fill-hover': 'rgb(2, 2, 2)',
        '--ds-separator': 'rgb(3, 3, 3)',
        '--ds-label': 'rgb(4, 4, 4)',
        '--ds-label-tertiary': 'rgb(5, 5, 5)',
        '--ds-danger': 'rgb(6, 6, 6)',
      };
      for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value);
      try {
        const view = await renderLoadedTab('browser-toolbar-theme');

        fireEvent.click(view.getByRole('button', { name: 'Select element' }));

        await waitFor(() => {
          expect(invoke).toHaveBeenCalledWith('browser_inspect_set', expect.objectContaining({ enabled: true }));
        });
        const [, args] = invoke.mock.calls.find(([command]) => command === 'browser_inspect_set')!;
        expect(args.labels.theme).toEqual({
          bgBase: 'rgb(1, 1, 1)',
          bgHover: 'rgb(2, 2, 2)',
          borderSubtle: 'rgb(3, 3, 3)',
          textPrimary: 'rgb(4, 4, 4)',
          textTertiary: 'rgb(5, 5, 5)',
          danger: 'rgb(6, 6, 6)',
        });
      } finally {
        for (const name of Object.keys(tokens)) root.style.removeProperty(name);
      }
    });

    it('shows the start prompt on the panel card colour until a page is committed', () => {
      const view = renderTab('browser-toolbar-start', '');

      const prompt = view.getByText('Enter a URL to start');
      expect(prompt).toHaveClass('text-title');
      expect(view.container.querySelector('.bg-surface')).toContainElement(prompt);
    });

    it('does not render again while a message streams or an unrelated tab changes', async () => {
      let commits = 0;
      render(
        <DesignSystemProvider>
          <Profiler id="browser-tab" onRender={() => { commits += 1; }}>
            <BrowserTab tabId="browser-toolbar-renders" url="https://example.com" />
          </Profiler>
        </DesignSystemProvider>,
      );
      await waitFor(() => {
        expect(invoke).toHaveBeenCalledWith('browser_create', expect.objectContaining({ id: 'browser-toolbar-renders' }));
      });
      await act(async () => { await Promise.resolve(); });
      const before = commits;
      expect(before).toBeGreaterThan(0);

      for (const text of ['Once', 'Once upon', 'Once upon a time']) {
        act(() => {
          useChatStore.setState({
            conversations: {
              'active-conversation': {
                id: 'active-conversation',
                title: 'Streaming',
                messages: [{ id: 'm1', role: 'assistant', content: text, timestamp: 1 }],
                createdAt: 1,
                updatedAt: 1,
                status: 'running',
              },
            },
          } as never);
        });
        act(() => usePreviewStore.getState().updateBrowserUrl('some-other-tab', `https://other.example.com/${text.length}`));
      }

      expect(commits).toBe(before);
    });
  });

  describe('control and popup notices', () => {
    type ControlHandler = (event: { payload: string }) => void;

    async function renderWithControl(tabId: string) {
      const handlers = new Map<string, (event: never) => void>();
      listen.mockImplementation((event: string, handler: (e: never) => void) => {
        handlers.set(event, handler);
        return Promise.resolve(() => {});
      });
      const view = renderTab(tabId, 'https://example.com');
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('browser_control', { id: tabId }));
      await waitFor(() => expect(handlers.has(`browser://control/${tabId}`)).toBe(true));
      const setPhase = (phase: string) => {
        act(() => (handlers.get(`browser://control/${tabId}`) as ControlHandler)({ payload: phase }));
      };
      const blockPopup = () => {
        act(() => (handlers.get(`browser://popup-blocked/${tabId}`) as () => void)());
      };
      return { view, setPhase, blockPopup };
    }

    it('shows no notice while Abu drives the page', async () => {
      const { view } = await renderWithControl('browser-notice-none');

      expect(view.queryByRole('status')).toBeNull();
      expect(view.queryByRole('alert')).toBeNull();
    });

    it('tells the user in place that they are in control, with a still icon', async () => {
      const { view, setPhase } = await renderWithControl('browser-notice-human');

      setPhase('human');

      const notice = view.getByRole('status');
      expect(notice).toHaveTextContent('You are in control. Hand the page back when you are ready for Abu to continue.');
      expect(notice).toHaveClass('bg-info-soft');
      expect(notice.querySelector('svg')).not.toBeNull();
      expect(view.container.querySelector('[data-ds-spinner]')).toBeNull();
      expect(view.getByRole('button', { name: 'Hand back to Abu' })).toBeEnabled();
    });

    it('shows one spinner with the sentence while the page is handed back', async () => {
      const { view, setPhase } = await renderWithControl('browser-notice-yielding');

      setPhase('human');
      setPhase('yielding');

      expect(view.container.querySelectorAll('[data-ds-spinner]')).toHaveLength(1);
      const status = view.getByRole('status');
      expect(status).toHaveTextContent('Finishing the current action…');
      expect(status).toContainElement(view.container.querySelector('[data-ds-spinner]') as HTMLElement);
      expect(status).not.toHaveClass('bg-info-soft');
      expect(view.queryByText(/You are in control/)).toBeNull();
      // The control button keeps its existing wording and stays unavailable.
      expect(view.getByRole('button', { name: 'Finishing the current action…' })).toBeDisabled();
    });

    it('announces a failed hand-back as an alert and lets the user retry', async () => {
      const { view, setPhase } = await renderWithControl('browser-notice-failed');

      setPhase('yield-failed');

      const alert = view.getByRole('alert');
      expect(alert).toHaveTextContent('Could not change control. Try again.');
      expect(alert).toHaveClass('bg-danger-soft');
      expect(view.queryByRole('status')).toBeNull();
      expect(view.container.querySelector('[data-ds-spinner]')).toBeNull();
    });

    it('shows a failed control request as an alert', async () => {
      const { view } = await renderWithControl('browser-notice-rejected');
      invoke.mockImplementation(async (command: string, args?: { action?: string }) => {
        if (command === 'browser_control' && args?.action) throw new Error('host refused');
        return undefined;
      });

      fireEvent.click(view.getByRole('button', { name: 'Take control' }));

      await waitFor(() => expect(view.getByRole('alert')).toHaveTextContent('Could not change control. Try again.'));
      expect(view.getByRole('button', { name: 'Take control' })).toBeEnabled();
    });

    it('keeps the dismiss button inside the blocked-popup notice', async () => {
      const { view, blockPopup } = await renderWithControl('browser-notice-popup');

      blockPopup();

      const notice = view.getByRole('status');
      expect(notice).toHaveTextContent('Popup blocked. Keep the current page open and avoid submitting again.');
      expect(notice).toHaveClass('bg-warning-soft');
      const dismiss = view.getByRole('button', { name: 'Dismiss hint' });
      expect(notice).toContainElement(dismiss);

      fireEvent.click(dismiss);

      expect(view.queryByRole('status')).toBeNull();
      expect(view.queryByRole('button', { name: 'Dismiss hint' })).toBeNull();
    });

    it('stacks the control notice above the blocked-popup notice, between the toolbar and the page', async () => {
      const { view, setPhase, blockPopup } = await renderWithControl('browser-notice-both');

      setPhase('human');
      blockPopup();

      const notices = view.getAllByRole('status');
      expect(notices).toHaveLength(2);
      expect(notices[0]).toHaveTextContent(/You are in control/);
      expect(notices[1]).toHaveTextContent(/Popup blocked/);
      const strip = notices[0].parentElement as HTMLElement;
      expect(strip).toContainElement(notices[1]);
      const toolbar = view.getByRole('button', { name: 'Back' }).parentElement as HTMLElement;
      expect(strip.previousElementSibling).toBe(toolbar);
      expect(strip.nextElementSibling).toHaveClass('bg-surface');
    });
  });

  // The address bar's keyboard and URL handling, pinned so a change of the input
  // component cannot alter what the user's typing does.
  describe('address bar keyboard and URL handling', () => {
    const navigations = () => invoke.mock.calls.filter(
      ([command]) => command === 'browser_create' || command === 'browser_navigate',
    );

    async function renderLoadedTab(tabId: string) {
      const view = renderTab(tabId, 'https://example.com');
      await waitFor(() => {
        expect(invoke).toHaveBeenCalledWith('browser_create', expect.objectContaining({ id: tabId }));
      });
      invoke.mockClear();
      return view.getByPlaceholderText('Enter a URL or search') as HTMLInputElement;
    }

    it('focuses the address bar of an empty tab and creates no native view', async () => {
      const view = renderTab('browser-address-empty', '');
      const input = view.getByPlaceholderText('Enter a URL or search');

      await waitFor(() => expect(document.activeElement).toBe(input));
      expect(navigations()).toHaveLength(0);
      expect(view.getByText('Enter a URL to start')).toBeInTheDocument();
    });

    it('creates the native view at the normalised URL when Enter commits the first address', async () => {
      const view = renderTab('browser-address-first', '');
      const input = view.getByPlaceholderText('Enter a URL or search') as HTMLInputElement;

      fireEvent.change(input, { target: { value: '  example.org/path  ' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      await waitFor(() => {
        expect(invoke).toHaveBeenCalledWith('browser_create', expect.objectContaining({
          id: 'browser-address-first',
          url: 'https://example.org/path',
        }));
      });
      expect(input.value).toBe('https://example.org/path');
      expect(view.queryByText('Enter a URL to start')).toBeNull();
    });

    it('sends a bare local address over http and keeps an explicit scheme', async () => {
      const input = await renderLoadedTab('browser-address-schemes');

      fireEvent.change(input, { target: { value: 'localhost:5173/app' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => {
        expect(invoke).toHaveBeenCalledWith('browser_navigate', { id: 'browser-address-schemes', url: 'http://localhost:5173/app' });
      });
      expect(input.value).toBe('http://localhost:5173/app');

      fireEvent.change(input, { target: { value: 'http://plain.example.com/' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => {
        expect(invoke).toHaveBeenCalledWith('browser_navigate', { id: 'browser-address-schemes', url: 'http://plain.example.com/' });
      });
    });

    it('does nothing when Enter is pressed on a blank address', async () => {
      const input = await renderLoadedTab('browser-address-blank');

      fireEvent.change(input, { target: { value: '   ' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await act(async () => { await Promise.resolve(); });

      expect(navigations()).toHaveLength(0);
      expect(input.value).toBe('   ');
    });

    it('navigates only on Enter, not on other keys or on typing', async () => {
      const input = await renderLoadedTab('browser-address-enter-only');

      fireEvent.change(input, { target: { value: 'https://typed.example.com' } });
      fireEvent.keyDown(input, { key: 'Tab' });
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      fireEvent.keyDown(input, { key: ' ' });
      await act(async () => { await Promise.resolve(); });

      expect(navigations()).toHaveLength(0);
      expect(input.value).toBe('https://typed.example.com');
    });

    it('keeps the caret where it is when the address bar receives focus', async () => {
      const input = await renderLoadedTab('browser-address-caret');

      input.setSelectionRange(8, 8);
      fireEvent.focus(input);

      expect(input.value).toBe('https://example.com');
      expect(input.selectionStart).toBe(8);
      expect(input.selectionEnd).toBe(8);
    });

    it('holds text typed through an input method as a draft until Enter', async () => {
      const input = await renderLoadedTab('browser-address-ime');

      fireEvent.focus(input);
      fireEvent.compositionStart(input);
      fireEvent.change(input, { target: { value: 'tianqi' } });
      fireEvent.compositionUpdate(input, { data: 'tianqi' });
      fireEvent.change(input, { target: { value: '天气' } });
      fireEvent.compositionEnd(input, { data: '天气' });
      await act(async () => { await Promise.resolve(); });

      expect(navigations()).toHaveLength(0);
      expect(input.value).toBe('天气');

      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => {
        expect(invoke).toHaveBeenCalledWith('browser_navigate', { id: 'browser-address-ime', url: 'https://天气' });
      });
    });
  });

});
