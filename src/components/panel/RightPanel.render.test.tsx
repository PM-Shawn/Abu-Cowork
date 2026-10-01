// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ds/button';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { Conversation } from '@/types';
import RightPanel from './RightPanel';

const tabStrip = vi.hoisted(() => ({ renders: 0 }));

// The tab strip holds the panel's floating layers (the new-tab menu, one context menu
// per tab, the tooltips). Counting its renders shows whether the panel frame re-renders.
vi.mock('./workspace/TabStrip', () => ({
  default: () => {
    tabStrip.renders += 1;
    return null;
  },
}));
vi.mock('./workspace/SummaryBody', () => ({
  default: () => <div>Summary body</div>,
}));
vi.mock('./workspace/TerminalTab', () => ({
  default: () => <div>Terminal</div>,
}));

const CONVERSATION_ID = 'conv-render';
const VIEWPORT_WIDTH = 1600;

function conversation(): Conversation {
  return {
    id: CONVERSATION_ID,
    title: 'Render count',
    messages: [
      { id: 'm1', role: 'user', content: 'Write a long answer', timestamp: 1 },
      { id: 'm2', role: 'assistant', content: 'Once', timestamp: 2 },
    ],
    createdAt: 1,
    updatedAt: 1,
    status: 'running',
    workspacePath: '/workspace/render-count',
  };
}

// Stands in for App, which re-renders on every streamed token.
function Host() {
  const [ticks, setTicks] = useState(0);
  return (
    <DesignSystemProvider>
      <Button onClick={() => setTicks((n) => n + 1)}>Tick {ticks}</Button>
      <RightPanel />
    </DesignSystemProvider>
  );
}

function appendToLastMessage(text: string) {
  const { conversations } = useChatStore.getState();
  const current = conversations[CONVERSATION_ID];
  const last = current.messages[current.messages.length - 1];
  useChatStore.setState({
    conversations: {
      ...conversations,
      [CONVERSATION_ID]: {
        ...current,
        messages: [...current.messages.slice(0, -1), { ...last, content: `${last.content}${text}` }],
      },
    },
  });
}

function panel(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-abu-right-panel]');
  if (!el) throw new Error('the right panel is not mounted');
  return el;
}

function resizeHandle(): HTMLElement {
  const el = document.querySelector<HTMLElement>('div.cursor-col-resize');
  if (!el) throw new Error('the resize handle is not mounted');
  return el;
}

async function renderPanel() {
  const result = render(<Host />);
  // Let the mount effects (tab restore, default summary tab) settle.
  await act(async () => {});
  return result;
}

const originalInnerWidth = window.innerWidth;

describe('RightPanel', () => {
  beforeAll(() => {
    // happy-dom has no pointer capture; the resize handle and Radix both call it.
    HTMLElement.prototype.setPointerCapture ??= () => {};
    HTMLElement.prototype.releasePointerCapture ??= () => {};
    HTMLElement.prototype.hasPointerCapture ??= () => false;
  });

  beforeEach(() => {
    initLanguage('en-US');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEWPORT_WIDTH });
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.body.style.pointerEvents = '';
    useChatStore.setState({
      conversations: { [CONVERSATION_ID]: conversation() },
      activeConversationId: CONVERSATION_ID,
    });
    useSettingsStore.setState({
      rightPanelCollapsed: false,
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
      panelStateByConversation: {},
    });
    tabStrip.renders = 0;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
  });

  describe('render count', () => {
    it('keeps the tab strip still while its parent re-renders', async () => {
      await renderPanel();
      expect(usePreviewStore.getState().tabs.map((tab) => tab.kind)).toEqual(['summary']);
      const before = tabStrip.renders;
      expect(before).toBeGreaterThan(0);

      for (let i = 0; i < 3; i += 1) {
        fireEvent.click(screen.getByRole('button', { name: /^Tick/ }));
      }

      expect(screen.getByRole('button', { name: 'Tick 3' })).toBeInTheDocument();
      expect(tabStrip.renders).toBe(before);
    });

    it('keeps the tab strip still while the last message streams in', async () => {
      await renderPanel();
      expect(usePreviewStore.getState().tabs.map((tab) => tab.kind)).toEqual(['summary']);
      const before = tabStrip.renders;
      expect(before).toBeGreaterThan(0);

      for (const chunk of [' upon', ' a', ' time']) {
        act(() => appendToLastMessage(chunk));
      }

      const messages = useChatStore.getState().conversations[CONVERSATION_ID].messages;
      expect(messages[messages.length - 1].content).toBe('Once upon a time');
      expect(tabStrip.renders).toBe(before);
    });
  });

  describe('resize handle', () => {
    it('resizes the narrow panel through pointer capture without a full-window layer', async () => {
      const capture = vi.spyOn(HTMLElement.prototype, 'setPointerCapture');
      await renderPanel();
      const handle = resizeHandle();
      expect(panel().style.width).toBe('320px');

      fireEvent.pointerDown(handle, { button: 0, clientX: 800, pointerId: 1 });
      expect(capture).toHaveBeenCalledWith(1);
      expect(document.body.style.cursor).toBe('col-resize');
      expect(document.body.style.userSelect).toBe('none');
      // Keeps an iframe under the pointer from taking the moves.
      expect(document.body.style.pointerEvents).toBe('none');
      expect(document.querySelector('.fixed')).toBeNull();

      fireEvent.pointerMove(handle, { clientX: 760, pointerId: 1 });
      expect(panel().style.width).toBe('360px');
      expect(panel().style.transition).toBe('none');
      expect(document.querySelector('.fixed')).toBeNull();

      fireEvent.pointerUp(handle, { clientX: 760, pointerId: 1 });
      expect(document.body.style.cursor).toBe('');
      expect(document.body.style.userSelect).toBe('');
      expect(document.body.style.pointerEvents).toBe('');
      expect(panel().style.width).toBe('360px');
      expect(document.querySelector('.fixed')).toBeNull();

      // The drag is over: further movement leaves the width alone.
      fireEvent.pointerMove(handle, { clientX: 700, pointerId: 1 });
      expect(panel().style.width).toBe('360px');
    });

    it('keeps the narrow panel inside its limits', async () => {
      await renderPanel();
      const handle = resizeHandle();

      fireEvent.pointerDown(handle, { button: 0, clientX: 800, pointerId: 1 });
      fireEvent.pointerMove(handle, { clientX: 100, pointerId: 1 });
      expect(panel().style.width).toBe('560px');
      fireEvent.pointerMove(handle, { clientX: 1500, pointerId: 1 });
      expect(panel().style.width).toBe('260px');
      fireEvent.pointerUp(handle, { clientX: 1500, pointerId: 1 });
    });

    it('ends the drag when the capture is lost', async () => {
      await renderPanel();
      const handle = resizeHandle();

      fireEvent.pointerDown(handle, { button: 0, clientX: 800, pointerId: 1 });
      fireEvent.pointerMove(handle, { clientX: 780, pointerId: 1 });
      expect(panel().style.width).toBe('340px');

      fireEvent.lostPointerCapture(handle, { pointerId: 1 });
      expect(document.body.style.cursor).toBe('');
      expect(document.body.style.userSelect).toBe('');
      expect(document.body.style.pointerEvents).toBe('');

      fireEvent.pointerMove(handle, { clientX: 700, pointerId: 1 });
      expect(panel().style.width).toBe('340px');
    });

    it('ignores buttons other than the primary one', async () => {
      const capture = vi.spyOn(HTMLElement.prototype, 'setPointerCapture');
      await renderPanel();
      const handle = resizeHandle();

      fireEvent.pointerDown(handle, { button: 2, clientX: 800, pointerId: 1 });
      fireEvent.pointerMove(handle, { clientX: 760, pointerId: 1 });

      expect(capture).not.toHaveBeenCalled();
      expect(document.body.style.cursor).toBe('');
      expect(panel().style.width).toBe('320px');
    });

    it('resizes the chat column and stores its width while wide content is open', async () => {
      await renderPanel();
      act(() => {
        usePreviewStore.getState().openTerminal();
      });
      const handle = resizeHandle();
      expect(usePreviewStore.getState().chatWidth).toBeNull();

      // 40% of the 1600px window is the starting chat width.
      fireEvent.pointerDown(handle, { button: 0, clientX: 800, pointerId: 1 });
      fireEvent.pointerMove(handle, { clientX: 840, pointerId: 1 });
      expect(usePreviewStore.getState().chatWidth).toBe(680);
      fireEvent.pointerMove(handle, { clientX: 1500, pointerId: 1 });
      expect(usePreviewStore.getState().chatWidth).toBe(820);
      fireEvent.pointerUp(handle, { clientX: 1500, pointerId: 1 });

      expect(usePreviewStore.getState().chatWidth).toBe(820);
      expect(document.body.style.cursor).toBe('');
    });

    it('restores the page cursor when the panel unmounts mid-drag', async () => {
      const { unmount } = await renderPanel();

      fireEvent.pointerDown(resizeHandle(), { button: 0, clientX: 800, pointerId: 1 });
      expect(document.body.style.cursor).toBe('col-resize');
      unmount();

      expect(document.body.style.cursor).toBe('');
      expect(document.body.style.userSelect).toBe('');
      expect(document.body.style.pointerEvents).toBe('');
    });

    it('leaves the page’s pointer handling alone when it unmounts without a drag', async () => {
      const { unmount } = await renderPanel();
      // An open modal menu sets this on the page; the panel must not undo it.
      document.body.style.pointerEvents = 'none';

      unmount();

      expect(document.body.style.pointerEvents).toBe('none');
      document.body.style.pointerEvents = '';
    });
  });
});
