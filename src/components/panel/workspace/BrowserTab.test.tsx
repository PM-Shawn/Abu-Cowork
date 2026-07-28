/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BrowserTab from './BrowserTab';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useSettingsStore } from '@/stores/settingsStore';
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
    delete (globalThis as typeof globalThis & { __ABU_SHELL__?: unknown }).__ABU_SHELL__;
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
    delete (globalThis as typeof globalThis & { __ABU_SHELL__?: unknown }).__ABU_SHELL__;
    approvalBridge.drainAll('command');
    approvalBridge.drainAll('file-permission');
    approvalBridge.drainAll('workspace');
    drainCapabilitySetupRequests();
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
});
