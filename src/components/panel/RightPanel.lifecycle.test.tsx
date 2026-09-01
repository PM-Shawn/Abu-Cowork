// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import RightPanel from './RightPanel';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { Conversation } from '@/types';

// Only BrowserTab stays real — this suite is about the native browser view's
// lifetime, and the other tab bodies pull in editors/xterm we don't need.
vi.mock('./PreviewPanel', () => ({
  default: () => <div>Preview</div>,
}));
vi.mock('./workspace/TerminalTab', () => ({
  default: () => <div>Terminal</div>,
}));
vi.mock('./workspace/SummaryBody', () => ({
  default: () => <div>Summary body</div>,
}));

const invokeMock = vi.mocked(invoke);

const BROWSER_TAB_ID = 'browser-lifecycle-view';

function conversation(id: string): Conversation {
  return {
    id,
    title: id,
    messages: [{ id: `${id}-m1`, role: 'user', content: 'hi', timestamp: 1 }],
    createdAt: 1,
    updatedAt: 1,
    status: 'idle',
    workspacePath: '/tmp/workspace',
  };
}

function panelEl(): HTMLElement | null {
  return document.querySelector('[data-abu-right-panel]');
}

function browserTabMounted(): boolean {
  return document.querySelector('input[placeholder]') !== null;
}

async function renderPanel() {
  const result = render(
    <TooltipProvider>
      <RightPanel />
    </TooltipProvider>,
  );
  // Auto-expand fires once per conversation on mount (workspace + messages).
  await waitFor(() => {
    expect(useSettingsStore.getState().rightPanelCollapsed).toBe(false);
  });
  return result;
}

/** Seed one agent browser tab plus a conversation-scoped summary tab. */
async function seedBrowserTab() {
  act(() => {
    usePreviewStore.setState({
      tabs: [
        { id: 'summary-tab', kind: 'summary' },
        { id: BROWSER_TAB_ID, kind: 'browser', url: 'https://example.com' },
      ],
      activeTabId: BROWSER_TAB_ID,
    });
  });
  await waitFor(() => {
    expect(invokeMock).toHaveBeenCalledWith(
      'browser_create',
      expect.objectContaining({ id: BROWSER_TAB_ID }),
    );
  });
  invokeMock.mockClear();
}

describe('RightPanel browser view lifecycle', () => {
  beforeEach(() => {
    const runtime = globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown };
    runtime.__TAURI_INTERNALS__ = {};
    initLanguage('en-US');
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);

    useChatStore.setState({
      conversations: { a: conversation('a'), b: conversation('b') },
      activeConversationId: 'a',
    });
    useSettingsStore.setState({
      // Start collapsed so RightPanel's once-per-conversation auto-expand fires
      // on mount and is spent — otherwise it would fight the manual collapse
      // this suite performs (pre-existing behaviour, unrelated to view
      // lifetime).
      rightPanelCollapsed: true,
      viewMode: 'chat',
      systemSettingsOpen: false,
      sidebarCollapsed: true,
    });
    usePreviewStore.setState({
      tabs: [],
      activeTabId: null,
      focusTabId: null,
      menuOpen: false,
      appModalOpen: false,
      previewFilePath: null,
      chatWidth: null,
      reloadNonce: 0,
      fileTreeMode: false,
    });

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

  it('keeps the browser tab and its native view when the conversation changes', async () => {
    await renderPanel();
    await seedBrowserTab();

    await act(async () => {
      useChatStore.setState({ activeConversationId: 'b' });
    });

    // Conversation-scoped tabs still reset; the agent's browser tab survives.
    expect(usePreviewStore.getState().tabs.map((tab) => tab.kind)).toEqual(['browser']);
    expect(invokeMock).not.toHaveBeenCalledWith('browser_close', expect.anything());
    expect(browserTabMounted()).toBe(true);
  });

  it('keeps the panel mounted (hidden) when collapsed, so the native view survives', async () => {
    await renderPanel();
    await seedBrowserTab();

    await act(async () => {
      useSettingsStore.setState({ rightPanelCollapsed: true });
    });

    expect(panelEl()).toBeInTheDocument();
    expect(panelEl()).toHaveAttribute('hidden');
    expect(browserTabMounted()).toBe(true);
    expect(invokeMock).not.toHaveBeenCalledWith('browser_close', expect.anything());
  });

  it('keeps the panel mounted (hidden) when the view mode leaves chat', async () => {
    await renderPanel();
    await seedBrowserTab();

    await act(async () => {
      useSettingsStore.setState({ viewMode: 'automation' });
    });

    expect(panelEl()).toHaveAttribute('hidden');
    expect(browserTabMounted()).toBe(true);
    expect(invokeMock).not.toHaveBeenCalledWith('browser_close', expect.anything());
  });

  it('still destroys the native view when the user closes the tab explicitly', async () => {
    await renderPanel();
    await seedBrowserTab();

    await act(async () => {
      usePreviewStore.getState().closeTab(BROWSER_TAB_ID);
    });

    expect(invokeMock).toHaveBeenCalledWith('browser_close', { id: BROWSER_TAB_ID });
    expect(usePreviewStore.getState().tabs.map((tab) => tab.id)).not.toContain(BROWSER_TAB_ID);
  });
});
