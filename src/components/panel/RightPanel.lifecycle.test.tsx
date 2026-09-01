// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import RightPanel from './RightPanel';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { getVisibleTabs, usePreviewStore, workspaceTabButtonId } from '@/stores/previewStore';
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
const OWNED_TAB_ID = 'browser-owned-view';

function conversation(id: string, workspacePath: string | null = '/tmp/workspace'): Conversation {
  return {
    id,
    title: id,
    messages: [{ id: `${id}-m1`, role: 'user', content: 'hi', timestamp: 1 }],
    createdAt: 1,
    updatedAt: 1,
    status: 'idle',
    ...(workspacePath ? { workspacePath } : {}),
  };
}

const LAID_OUT_RECT = {
  bottom: 500,
  height: 400,
  left: 100,
  right: 700,
  top: 100,
  width: 600,
  x: 100,
  y: 100,
  toJSON: () => ({}),
} as DOMRect;

const ZERO_RECT = {
  bottom: 0,
  height: 0,
  left: 0,
  right: 0,
  top: 0,
  width: 0,
  x: 0,
  y: 0,
  toJSON: () => ({}),
} as DOMRect;

/**
 * happy-dom has no layout engine, so model the ONE geometric fact this suite
 * depends on: an element under a `display:none` / `[hidden]` ancestor has a
 * zero rect and a null `offsetParent`. Driving the stubs off the real DOM keeps
 * BrowserTab's actual visibility branch under test — a constant "laid out"
 * stub would hide the very code path that keeps a collapsed panel from leaving
 * a native page painted over the app.
 */
function underHiddenAncestor(el: Element | null): boolean {
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.hasAttribute('hidden') || node.style.display === 'none') return true;
  }
  return false;
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
    usePreviewStore.getState().openSummary();
    // No owner id — the legacy/user-opened shape, visible in any conversation.
    usePreviewStore.getState().openBrowser('https://example.com', BROWSER_TAB_ID);
  });
  await waitFor(() => {
    expect(invokeMock).toHaveBeenCalledWith(
      'browser_create',
      expect.objectContaining({ id: BROWSER_TAB_ID }),
    );
  });
  invokeMock.mockClear();
}

/**
 * Seed an agent browser tab ADOPTED FOR `conversationId` — the production path
 * (`browser://automation-open` → `openBrowser(url, id, ownerId)`), so the tab
 * carries its owner rather than being a legacy any-conversation tab.
 */
async function seedOwnedBrowserTab(conversationId: string) {
  act(() => {
    usePreviewStore.getState().openBrowser('https://example.com', OWNED_TAB_ID, conversationId);
  });
  await waitFor(() => {
    expect(invokeMock).toHaveBeenCalledWith(
      'browser_create',
      expect.objectContaining({ id: OWNED_TAB_ID }),
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
      currentConversationId: null,
      lastActiveTabByConversation: {},
    });

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        return underHiddenAncestor(this) ? ZERO_RECT : LAID_OUT_RECT;
      },
    );
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
      configurable: true,
      get(this: HTMLElement) {
        return underHiddenAncestor(this) ? null : document.body;
      },
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

  // The keep-alive above is only safe because the native layer — which paints
  // OVER React and ignores CSS — actually goes away with the panel. That rests
  // entirely on BrowserTab reading a zero rect / null offsetParent, so exercise
  // it for real rather than stubbing the geometry to "always laid out".
  it('hides the native layer while the panel is collapsed and shows the same view on re-expand', async () => {
    await renderPanel();
    await seedBrowserTab();

    await act(async () => {
      useSettingsStore.setState({ rightPanelCollapsed: true });
    });

    // The tab is still mounted, so this hide can only have come from syncBounds
    // seeing the collapsed panel's zero rect — not from an unmount cleanup.
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('browser_hide', { id: BROWSER_TAB_ID });
    });
    expect(browserTabMounted()).toBe(true);

    // Let a few more syncBounds ticks run: a hidden pane must not resume
    // painting the native layer over whatever replaced it.
    const hideIndex = invokeMock.mock.calls.findIndex(([command]) => command === 'browser_hide');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    const afterHide = invokeMock.mock.calls.slice(hideIndex + 1).map(([command]) => command);
    expect(afterHide).not.toContain('browser_set_bounds');
    expect(afterHide).not.toContain('browser_show');

    await act(async () => {
      useSettingsStore.setState({ rightPanelCollapsed: false });
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('browser_show', { id: BROWSER_TAB_ID });
    });
    // Shown, never re-created: same WebContentsView, so the same tab id the
    // agent is already holding.
    expect(invokeMock).not.toHaveBeenCalledWith('browser_create', expect.anything());
  });

  // C1 left the surviving browser tab active for whatever conversation the user
  // switched to, so B's panel opened on A's live page and B never got its own
  // summary. An adopted tab belongs to its owner conversation only.
  it('hides conversation A’s agent tab from B, which opens its own summary instead', async () => {
    await renderPanel();
    await seedOwnedBrowserTab('a');

    await act(async () => {
      useChatStore.setState({ activeConversationId: 'b' });
    });

    const s = usePreviewStore.getState();
    // The view is alive — just not B's business.
    expect(s.tabs.map((tab) => tab.id)).toContain(OWNED_TAB_ID);
    expect(invokeMock).not.toHaveBeenCalledWith('browser_close', expect.anything());
    expect(browserTabMounted()).toBe(true);
    // B sees only its own freshly opened summary.
    expect(getVisibleTabs().map((tab) => tab.kind)).toEqual(['summary']);
    expect(s.activeTabId).toBe(getVisibleTabs()[0].id);
    // ...and the tab strip does not offer A's tab.
    expect(document.getElementById(workspaceTabButtonId(OWNED_TAB_ID))).toBeNull();

    // The native layer paints over React, so an invisible tab MUST be hidden.
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('browser_hide', { id: OWNED_TAB_ID });
    });
  });

  it('restores conversation A’s agent tab when the user switches back', async () => {
    await renderPanel();
    await seedOwnedBrowserTab('a');

    await act(async () => {
      useChatStore.setState({ activeConversationId: 'b' });
    });
    // Let the native layer actually go down in B before coming back, so the
    // re-show below is a real state transition rather than a no-op.
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('browser_hide', { id: OWNED_TAB_ID });
    });
    invokeMock.mockClear();
    await act(async () => {
      useChatStore.setState({ activeConversationId: 'a' });
    });

    const s = usePreviewStore.getState();
    expect(getVisibleTabs().map((tab) => tab.id)).toEqual([OWNED_TAB_ID]);
    expect(s.activeTabId).toBe(OWNED_TAB_ID);
    expect(document.getElementById(workspaceTabButtonId(OWNED_TAB_ID))).not.toBeNull();
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('browser_show', { id: OWNED_TAB_ID });
    });
    // Same WebContentsView the agent is still driving.
    expect(invokeMock).not.toHaveBeenCalledWith('browser_create', expect.anything());
  });

  // The wide-content effect auto-expands the panel and collapses the sidebar.
  // Once C2 scoped tabs per conversation, `hasWideContent` started flipping on
  // every switch, so returning to a conversation with an agent browser tab
  // replayed that "content just opened" reaction — overriding whatever the user
  // had arranged. Only a flip WITHIN one conversation may trigger it.
  it('auto-expands and collapses the sidebar the first time wide content appears', async () => {
    await renderPanel();
    await act(async () => {
      useSettingsStore.setState({ rightPanelCollapsed: true, sidebarCollapsed: false });
    });

    await seedOwnedBrowserTab('a');

    expect(useSettingsStore.getState().rightPanelCollapsed).toBe(false);
    expect(useSettingsStore.getState().sidebarCollapsed).toBe(true);
  });

  it('does not replay the auto-expand reaction on an A → B → A round trip', async () => {
    await renderPanel();
    await seedOwnedBrowserTab('a');
    // The user's arrangement: sidebar deliberately open next to the browser tab.
    await act(async () => {
      useSettingsStore.setState({ sidebarCollapsed: false });
    });

    await act(async () => {
      useChatStore.setState({ activeConversationId: 'b' });
    });
    await act(async () => {
      useChatStore.setState({ activeConversationId: 'a' });
    });

    // A's tab is visible again (a false→true flip of hasWideContent), but it is
    // the same content coming back, not new content — the sidebar stays as the
    // user left it.
    expect(getVisibleTabs().map((tab) => tab.id)).toEqual([OWNED_TAB_ID]);
    expect(useSettingsStore.getState().sidebarCollapsed).toBe(false);
  });

  it('leaves a manually collapsed panel collapsed across a round trip', async () => {
    // Workspace-less conversations on purpose: the panel's OTHER auto-expand
    // (once per conversation, gated on `hasWorkspace`) would otherwise re-expand
    // on return for its own long-standing reasons, masking what this pins.
    useChatStore.setState({
      conversations: { a: conversation('a', null), b: conversation('b', null) },
      activeConversationId: 'a',
    });
    render(
      <TooltipProvider>
        <RightPanel />
      </TooltipProvider>,
    );
    await act(async () => {
      useSettingsStore.setState({ rightPanelCollapsed: false, sidebarCollapsed: true });
    });
    await seedOwnedBrowserTab('a');
    // The user collapses the panel while the agent keeps browsing.
    await act(async () => {
      useSettingsStore.setState({ rightPanelCollapsed: true });
    });

    await act(async () => {
      useChatStore.setState({ activeConversationId: 'b' });
    });
    await act(async () => {
      useChatStore.setState({ activeConversationId: 'a' });
    });

    expect(useSettingsStore.getState().rightPanelCollapsed).toBe(true);
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
