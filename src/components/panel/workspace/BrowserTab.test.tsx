// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
import { TooltipProvider } from '@/components/ui/tooltip';

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

  it('hides the native view for an active-conversation approval and restores it afterwards', async () => {
    render(
      <TooltipProvider>
        <BrowserTab
          tabId="browser-approval-regression"
          url="https://example.com"
        />
      </TooltipProvider>,
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
      <TooltipProvider>
        <BrowserTab
          tabId="browser-image-lightbox"
          url="https://example.com"
        />
      </TooltipProvider>,
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
      <TooltipProvider>
        <BrowserTab
          tabId="browser-lightbox-capture-handoff"
          url="https://example.com"
        />
      </TooltipProvider>,
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
      <TooltipProvider>
        <BrowserTab
          tabId="browser-created-under-lightbox"
          url="https://example.com"
        />
      </TooltipProvider>,
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
    const user = userEvent.setup();
    const view = render(
      <TooltipProvider>
        <BrowserTab
          tabId="browser-toolbar-tooltip"
          url="https://example.com"
        />
      </TooltipProvider>,
    );

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_create', expect.objectContaining({
        id: 'browser-toolbar-tooltip',
      }));
    });
    invoke.mockClear();

    const backButton = view.getAllByRole('button')[0];
    await user.hover(backButton);

    const tooltip = await view.findByRole('tooltip', { name: 'Back' });
    expect(tooltip.closest('[data-side]')).toHaveAttribute('data-side', 'top');

    await user.unhover(backButton);
    // happy-dom returns zero-sized bounding rects, which can make Radix's
    // hoverable-content grace area think the pointer never left after a
    // synthetic unhover. Force it with an explicit far-away pointermove —
    // see the equivalent note in TabStrip.test.tsx's tooltip test.
    fireEvent.pointerMove(document.body, { clientX: 9999, clientY: 9999 });
    await waitFor(() => {
      expect(view.queryByRole('tooltip', { name: 'Back' })).not.toBeInTheDocument();
    });

    expect(invoke).not.toHaveBeenCalledWith('browser_hide', expect.anything());
    expect(invoke).not.toHaveBeenCalledWith('browser_show', expect.anything());
  });

  it('hides the native view for task-local capability setup and restores it afterwards', async () => {
    render(
      <TooltipProvider>
        <BrowserTab
          tabId="browser-capability-setup"
          url="https://example.com"
        />
      </TooltipProvider>,
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
      <TooltipProvider>
        <BrowserTab
          tabId="browser-create-approval-race"
          url="https://example.com"
        />
      </TooltipProvider>,
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
      <TooltipProvider>
        <BrowserTab
          tabId="browser-created-under-setup"
          url="https://example.com"
        />
      </TooltipProvider>,
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
      <TooltipProvider>
        <BrowserTab
          tabId="browser-hide-retry"
          url="https://example.com"
        />
      </TooltipProvider>,
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
      <TooltipProvider>
        <BrowserTab
          tabId="browser-create-retry"
          url="https://example.com"
        />
      </TooltipProvider>,
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
      <TooltipProvider>
        <BrowserTab
          tabId="browser-create-retry-latest-url"
          url="https://old.example.com"
        />
      </TooltipProvider>,
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
      <TooltipProvider>
        <BrowserTab tabId="browser-adopted-hidden" url="https://example.com" />
      </TooltipProvider>,
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
      <TooltipProvider>
        <BrowserTab tabId="browser-visible-rect" url="https://example.com" />
      </TooltipProvider>,
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
});
