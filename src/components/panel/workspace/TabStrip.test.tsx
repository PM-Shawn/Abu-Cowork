// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ds/button';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import { makeBatchKey, type BatchIdentity } from '@/types';
import {
  BATCH_PROGRESS_GLOBAL_RICH_CONTENT_BYTES,
  useBatchProgressStore,
} from '@/stores/batchProgressStore';
import { subagentTabId, usePreviewStore, workspaceTabPanelId, type WorkspaceTab } from '@/stores/previewStore';
import TabStrip from './TabStrip';

const SUMMARY_ID = 'summary-tab';
const TERMINAL_ID = 'terminal-tab';

function seedTabs(activeTabId = TERMINAL_ID) {
  const tabs: WorkspaceTab[] = [
    { id: SUMMARY_ID, kind: 'summary' },
    { id: TERMINAL_ID, kind: 'terminal' },
  ];
  usePreviewStore.setState({
    tabs,
    activeTabId,
    focusTabId: null,
    menuOpen: false,
    appModalOpen: false,
    previewFilePath: null,
  });
}

function resetBatchStore() {
  useBatchProgressStore.setState({
    batches: {},
    activeVisibleBatchKey: undefined,
    richAccessClock: 0,
    richContentDiagnostics: {
      totalRetainedRichBytes: 0,
      retainedRichBytesCap: BATCH_PROGRESS_GLOBAL_RICH_CONTENT_BYTES,
      overageBytes: 0,
      evictionCount: 0,
      releasedBatchCount: 0,
      lastEvictedKey: undefined,
    },
  });
}

function identity(conversationId: string): BatchIdentity {
  return { conversationId, batchToolCallId: 'batch' };
}

function renderTabs() {
  return render(
    <DesignSystemProvider>
      <TabStrip />
    </DesignSystemProvider>,
  );
}

function tabIds() {
  return usePreviewStore.getState().tabs.map((tab) => tab.id);
}

describe('TabStrip pointer interactions', () => {
  beforeAll(() => {
    // happy-dom has no pointer capture; Radix menus call it.
    HTMLElement.prototype.setPointerCapture ??= () => {};
    HTMLElement.prototype.releasePointerCapture ??= () => {};
    HTMLElement.prototype.hasPointerCapture ??= () => false;
  });

  beforeEach(() => {
    initLanguage('en-US');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    resetBatchStore();
    seedTabs();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('treats a normal press as a click without entering drag mode', () => {
    renderTabs();
    const summary = screen.getByRole('tab', { name: /Task Summary/ });

    fireEvent.pointerDown(summary, { button: 0, clientX: 100, pointerId: 1 });

    expect(document.body.style.cursor).toBe('');
    expect(summary).not.toHaveClass('cursor-grabbing');

    fireEvent.pointerUp(window, { clientX: 100, pointerId: 1 });
    fireEvent.click(summary);

    expect(usePreviewStore.getState().activeTabId).toBe(SUMMARY_ID);
  });

  it('starts reordering only after movement crosses the drag threshold', () => {
    seedTabs(SUMMARY_ID);
    renderTabs();
    const summary = screen.getByRole('tab', { name: /Task Summary/ });
    const terminal = screen.getByRole('tab', { name: /Terminal/ });
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(summary);

    fireEvent.pointerDown(terminal, { button: 0, clientX: 100, pointerId: 2 });
    fireEvent.pointerMove(window, { clientX: 103, clientY: 12, pointerId: 2 });
    expect(document.body.style.cursor).toBe('');

    fireEvent.pointerMove(window, { clientX: 112, clientY: 12, pointerId: 2 });
    expect(document.body.style.cursor).toBe('grabbing');

    fireEvent.pointerUp(window, { clientX: 112, clientY: 12, pointerId: 2 });
    fireEvent.click(terminal);

    expect(usePreviewStore.getState().tabs.map((tab) => tab.id)).toEqual([
      TERMINAL_ID,
      SUMMARY_ID,
    ]);
    expect(usePreviewStore.getState().activeTabId).toBe(SUMMARY_ID);
    expect(document.body.style.cursor).toBe('');
  });

  it('offers a browser tab in the new-tab menu', async () => {
    const user = userEvent.setup();
    renderTabs();

    await user.click(screen.getByRole('button', { name: 'New tab' }));
    await user.click(screen.getByRole('menuitem', { name: 'New Browser' }));

    await waitFor(() => {
      expect(usePreviewStore.getState().tabs.at(-1)).toMatchObject({
        kind: 'browser',
        url: '',
      });
    });
  });

  it('lists the three things a new tab can be', async () => {
    const user = userEvent.setup();
    renderTabs();

    await user.click(screen.getByRole('button', { name: 'New tab' }));

    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Task Summary',
      'New Browser',
      'New Terminal',
    ]);
  });

  it('activates the existing summary from the new-tab menu', async () => {
    const user = userEvent.setup();
    renderTabs();

    await user.click(screen.getByRole('button', { name: 'New tab' }));
    await user.click(screen.getByRole('menuitem', { name: 'Task Summary' }));

    expect(tabIds()).toEqual([SUMMARY_ID, TERMINAL_ID]);
    expect(usePreviewStore.getState().activeTabId).toBe(SUMMARY_ID);
  });

  it('opens a terminal from the new-tab menu without handing focus back to the menu button', async () => {
    const user = userEvent.setup();
    renderTabs();

    await user.click(screen.getByRole('button', { name: 'New tab' }));
    await user.click(screen.getByRole('menuitem', { name: 'New Terminal' }));

    await waitFor(() => {
      expect(usePreviewStore.getState().tabs.map((tab) => tab.kind)).toEqual(['summary', 'terminal', 'terminal']);
    });
    expect(screen.getByRole('button', { name: 'New tab' })).not.toHaveFocus();
  });

  it('moves only the highlight with the arrow keys in the new-tab menu', async () => {
    const user = userEvent.setup();
    renderTabs();

    await user.click(screen.getByRole('button', { name: 'New tab' }));
    await user.keyboard('{ArrowDown}{ArrowDown}');

    expect(screen.getByRole('menuitem', { name: 'New Browser' })).toHaveAttribute('data-highlighted');
    expect(tabIds()).toEqual([SUMMARY_ID, TERMINAL_ID]);

    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(usePreviewStore.getState().tabs.map((tab) => tab.kind)).toEqual(['summary', 'terminal', 'browser']);
    });
  });

  it('closes the other tabs from a tab’s context menu', async () => {
    const user = userEvent.setup();
    renderTabs();

    fireEvent.contextMenu(screen.getByRole('tab', { name: /Terminal/ }));
    const closeOthers = screen.getByRole('menuitem', { name: 'Close other tabs' });
    expect(closeOthers).toBeVisible();
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Close other tabs',
      'Close all tabs',
    ]);
    await user.click(closeOthers);

    expect(tabIds()).toEqual([TERMINAL_ID]);
  });

  it('closes every tab from a tab’s context menu', async () => {
    const user = userEvent.setup();
    renderTabs();

    fireEvent.contextMenu(screen.getByRole('tab', { name: /Task Summary/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Close all tabs' }));

    expect(tabIds()).toEqual([]);
    expect(usePreviewStore.getState().menuOpen).toBe(false);
  });

  describe('native web layer', () => {
    it('stays hidden while the new-tab menu is open and comes back on Escape', async () => {
      const user = userEvent.setup();
      renderTabs();
      expect(usePreviewStore.getState().menuOpen).toBe(false);

      await user.click(screen.getByRole('button', { name: 'New tab' }));
      expect(usePreviewStore.getState().menuOpen).toBe(true);

      await user.keyboard('{Escape}');
      expect(usePreviewStore.getState().menuOpen).toBe(false);
    });

    it('stays hidden when a context menu replaces the new-tab menu', async () => {
      const user = userEvent.setup();
      renderTabs();

      await user.click(screen.getByRole('button', { name: 'New tab' }));
      expect(usePreviewStore.getState().menuOpen).toBe(true);

      // Opening the context menu makes the layer registry close the new-tab menu.
      // (An open menu hides the rest of the page from assistive technology.)
      fireEvent.contextMenu(screen.getByRole('tab', { name: /Terminal/, hidden: true }));
      expect(screen.queryByRole('menuitem', { name: 'New Browser' })).toBeNull();
      expect(screen.getByRole('menuitem', { name: 'Close other tabs' })).toBeInTheDocument();
      expect(usePreviewStore.getState().menuOpen).toBe(true);

      await user.keyboard('{Escape}');
      expect(screen.queryByRole('menuitem', { name: 'Close other tabs' })).toBeNull();
      expect(usePreviewStore.getState().menuOpen).toBe(false);
    });

    it('stays hidden when one tab’s context menu replaces another’s', async () => {
      const user = userEvent.setup();
      renderTabs();

      fireEvent.contextMenu(screen.getByRole('tab', { name: /Task Summary/ }));
      expect(usePreviewStore.getState().menuOpen).toBe(true);

      fireEvent.contextMenu(screen.getByRole('tab', { name: /Terminal/, hidden: true }));
      expect(screen.getAllByRole('menu')).toHaveLength(1);
      expect(usePreviewStore.getState().menuOpen).toBe(true);

      await user.keyboard('{Escape}');
      expect(usePreviewStore.getState().menuOpen).toBe(false);
    });

    it('stays hidden when a menu closes and a context menu opens within the same frame', async () => {
      // A right-click on a tab while a menu is open: the press closes the open menu,
      // the context-menu event that follows opens the tab's own menu.
      const queued: FrameRequestCallback[] = [];
      vi.mocked(window.requestAnimationFrame).mockImplementation((cb: FrameRequestCallback) => queued.push(cb));
      vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => {
        queued[id - 1] = () => {};
      });
      const flushFrames = () => act(() => {
        for (const cb of queued.splice(0)) cb(0);
      });
      const user = userEvent.setup();
      renderTabs();
      const reported: boolean[] = [];
      const unsubscribe = usePreviewStore.subscribe((state, previous) => {
        if (state.menuOpen !== previous.menuOpen) reported.push(state.menuOpen);
      });

      await user.click(screen.getByRole('button', { name: 'New tab' }));
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('menuitem', { name: 'New Browser' })).toBeNull();
      fireEvent.contextMenu(screen.getByRole('tab', { name: /Terminal/, hidden: true }));
      flushFrames();

      expect(screen.getByRole('menuitem', { name: 'Close other tabs' })).toBeInTheDocument();
      expect(reported).toEqual([true]);

      await user.keyboard('{Escape}');
      expect(usePreviewStore.getState().menuOpen).toBe(true);
      flushFrames();

      expect(reported).toEqual([true, false]);
      unsubscribe();
    });

    it('comes back when the strip unmounts while the report of the last close is still pending', async () => {
      const queued: FrameRequestCallback[] = [];
      vi.mocked(window.requestAnimationFrame).mockImplementation((cb: FrameRequestCallback) => queued.push(cb));
      vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => {
        queued[id - 1] = () => {};
      });
      const user = userEvent.setup();
      const { unmount } = renderTabs();

      await user.click(screen.getByRole('button', { name: 'New tab' }));
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('menuitem', { name: 'New Browser' })).toBeNull();
      expect(usePreviewStore.getState().menuOpen).toBe(true);

      unmount();
      expect(usePreviewStore.getState().menuOpen).toBe(false);

      // A later menu elsewhere must not be undone by the cancelled frame.
      usePreviewStore.getState().setMenuOpen(true);
      for (const cb of queued.splice(0)) cb(0);
      expect(usePreviewStore.getState().menuOpen).toBe(true);
    });

    it('comes back when the tab whose context menu is open goes away', () => {
      renderTabs();

      fireEvent.contextMenu(screen.getByRole('tab', { name: /Terminal/ }));
      expect(usePreviewStore.getState().menuOpen).toBe(true);

      // Not a choice from the menu: the tab is closed from elsewhere (an agent, a deleted file).
      act(() => {
        usePreviewStore.getState().closeTab(TERMINAL_ID);
      });

      expect(tabIds()).toEqual([SUMMARY_ID]);
      expect(usePreviewStore.getState().menuOpen).toBe(false);
    });

    it('comes back when the strip unmounts with a menu open', async () => {
      const user = userEvent.setup();
      const { unmount } = renderTabs();

      await user.click(screen.getByRole('button', { name: 'New tab' }));
      expect(usePreviewStore.getState().menuOpen).toBe(true);
      unmount();

      expect(usePreviewStore.getState().menuOpen).toBe(false);
    });
  });

  it('uses a readable title for a data-url image preview', () => {
    usePreviewStore.setState({
      tabs: [{ id: 'image-tab', kind: 'preview', filePath: 'data:image/png;base64,abc' }],
      activeTabId: 'image-tab',
      previewFilePath: 'data:image/png;base64,abc',
    });

    renderTabs();

    expect(screen.getByRole('tab', { name: /Image Preview/ })).toBeInTheDocument();
    expect(screen.queryByText(/base64/)).not.toBeInTheDocument();
  });

  it('marks the selected tab with the selected fill', () => {
    renderTabs();

    const summary = screen.getByRole('tab', { name: /Task Summary/ });
    const terminal = screen.getByRole('tab', { name: /Terminal/ });
    expect(terminal.closest('[data-tab-id]')).toHaveClass('bg-fill-selected');
    expect(terminal.closest('[data-tab-id]')).toHaveClass('text-label');
    expect(summary.closest('[data-tab-id]')).not.toHaveClass('bg-fill-selected');
    expect(summary.closest('[data-tab-id]')).toHaveClass('text-label-secondary');
  });

  it('lifts the dragged tab and marks where it will land', () => {
    seedTabs(SUMMARY_ID);
    renderTabs();
    const summary = screen.getByRole('tab', { name: /Task Summary/ });
    const terminal = screen.getByRole('tab', { name: /Terminal/ });
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(summary);

    fireEvent.pointerDown(terminal, { button: 0, clientX: 100, pointerId: 3 });
    fireEvent.pointerMove(window, { clientX: 60, clientY: 12, pointerId: 3 });

    const dragged = terminal.closest<HTMLElement>('[data-tab-id]');
    expect(dragged).toHaveClass('pointer-events-none');
    expect(dragged).toHaveClass('bg-raised');
    expect(dragged?.style.transform).toBe('translateX(-40px)');
    expect(summary.closest('[data-tab-id]')).toHaveClass('before:bg-label');

    fireEvent.pointerUp(window, { clientX: 60, clientY: 12, pointerId: 3 });
    expect(dragged).not.toHaveClass('pointer-events-none');
    expect(dragged?.style.transform).toBe('');
  });

  it('closes a tab on middle-click', () => {
    renderTabs();

    fireEvent(
      screen.getByRole('tab', { name: /Task Summary/ }),
      new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }),
    );

    expect(tabIds()).toEqual([TERMINAL_ID]);
  });

  it('exposes a real tablist with roving tabIndex and aria tabpanel linkage', () => {
    renderTabs();

    const tablist = screen.getByRole('tablist', { name: 'Workspace tabs' });
    const summary = screen.getByRole('tab', { name: /Task Summary/ });
    const terminal = screen.getByRole('tab', { name: /Terminal/ });

    expect(tablist).toContainElement(summary);
    expect(tablist).not.toContainElement(screen.getByRole('button', { name: 'New tab' }));
    expect(tablist).not.toContainElement(screen.getByRole('button', { name: 'Hide panel' }));
    expect(Array.from(tablist.children).every((child) => child.getAttribute('role') === 'presentation')).toBe(true);
    expect(within(tablist).getAllByRole('tab')).toHaveLength(2);
    expect(summary).toHaveAttribute('tabIndex', '-1');
    expect(terminal).toHaveAttribute('tabIndex', '0');
    expect(Array.from(tablist.querySelectorAll<HTMLElement>('[tabindex="0"]'))).toEqual([terminal]);
    expect(terminal).toHaveAttribute('aria-controls', workspaceTabPanelId(TERMINAL_ID));

    fireEvent.keyDown(terminal, { key: 'ArrowLeft' });
    expect(usePreviewStore.getState().activeTabId).toBe(SUMMARY_ID);
    expect(summary).toHaveFocus();

    fireEvent.keyDown(summary, { key: 'End' });
    expect(usePreviewStore.getState().activeTabId).toBe(TERMINAL_ID);
    expect(terminal).toHaveFocus();

    fireEvent.keyDown(terminal, { key: 'Home' });
    expect(usePreviewStore.getState().activeTabId).toBe(SUMMARY_ID);
    expect(summary).toHaveFocus();
  });

  // Delete hands the focus to the next tab; the repeats of a held Delete would close that one too.
  it('closes one tab per press of Delete: the repeats of a held Delete close nothing', () => {
    renderTabs();
    const before = tabIds();
    const terminal = screen.getByRole('tab', { name: /Terminal/ });
    terminal.focus();

    // fireEvent returns false once the default was prevented.
    expect(fireEvent.keyDown(terminal, { key: 'Delete', code: 'Delete', repeat: true })).toBe(false);
    expect(tabIds()).toEqual(before);

    fireEvent.keyDown(terminal, { key: 'Delete', code: 'Delete' });
    expect(tabIds()).toEqual([SUMMARY_ID]);
    fireEvent.keyDown(screen.getByRole('tab', { name: /Task Summary/ }), { key: 'Delete', code: 'Delete', repeat: true });
    expect(tabIds()).toEqual([SUMMARY_ID]);
  });

  it('closes the focused tab with Delete while preserving the single roving tab stop', () => {
    renderTabs();
    const tablist = screen.getByRole('tablist', { name: 'Workspace tabs' });
    const terminal = screen.getByRole('tab', { name: /Terminal/ });
    terminal.focus();

    fireEvent.keyDown(terminal, { key: 'Delete' });

    expect(usePreviewStore.getState().tabs.map((tab) => tab.id)).toEqual([SUMMARY_ID]);
    const summary = screen.getByRole('tab', { name: /Task Summary/ });
    expect(summary).toHaveFocus();
    expect(Array.from(tablist.querySelectorAll<HTMLElement>('[tabindex="0"]'))).toEqual([summary]);
  });

  it('keeps every close control visible as an adjacent named button', () => {
    renderTabs();

    const closeButtons = screen.getAllByRole('button', { name: /^Close / });
    expect(closeButtons).toHaveLength(2);
    for (const button of closeButtons) {
      expect(button).not.toHaveClass('opacity-0');
      expect(button).not.toHaveClass('group-hover:opacity-100');
    }

    fireEvent.click(closeButtons[0]);

    expect(usePreviewStore.getState().tabs.map((tab) => tab.id)).toEqual([TERMINAL_ID]);
  });

  it('focuses the resulting active neighbor when the close control removes the focused active tab', () => {
    renderTabs();
    const terminal = screen.getByRole('tab', { name: /Terminal/ });
    terminal.focus();

    fireEvent.click(screen.getByRole('button', { name: 'Close Terminal' }));

    expect(usePreviewStore.getState().activeTabId).toBe(SUMMARY_ID);
    expect(screen.getByRole('tab', { name: /Task Summary/ })).toHaveFocus();
  });

  it('focuses the active tab when closing a focused inactive tab via its close control', () => {
    renderTabs();
    const summaryClose = screen.getByRole('button', { name: 'Close Task Summary' });
    summaryClose.focus();

    fireEvent.click(summaryClose);

    expect(usePreviewStore.getState().activeTabId).toBe(TERMINAL_ID);
    expect(screen.getByRole('tab', { name: /Terminal/ })).toHaveFocus();
  });

  it('does not steal focus for programmatic file-deletion closes', () => {
    usePreviewStore.setState({
      tabs: [
        { id: 'external-preview', kind: 'preview', filePath: '/tmp/delete.md' },
        { id: TERMINAL_ID, kind: 'terminal' },
      ],
      activeTabId: 'external-preview',
      previewFilePath: '/tmp/delete.md',
      focusTabId: null,
    });
    render(
      <DesignSystemProvider>
        <Button>Outside control</Button>
        <TabStrip />
      </DesignSystemProvider>,
    );
    const outside = screen.getByRole('button', { name: 'Outside control' });
    outside.focus();

    usePreviewStore.getState().closePreviewTabsForPath('/tmp/delete.md');

    expect(usePreviewStore.getState().activeTabId).toBe(TERMINAL_ID);
    expect(outside).toHaveFocus();
  });

  it('shows an Agent tab and focuses it after openSubagent dedupe/open requests', () => {
    const idn = identity('conv-tab-focus');
    useBatchProgressStore.getState().initBatch(idn, ['Worker']);
    const id = usePreviewStore.getState().openSubagent(idn, 0, 'Worker A');

    renderTabs();

    const tab = screen.getByRole('tab', { name: 'Worker A' });
    expect(tab).toHaveFocus();
    expect(usePreviewStore.getState().focusTabId).toBeNull();
    expect(id).toBe(subagentTabId(idn, 0));
    expect(useBatchProgressStore.getState().activeVisibleBatchKey).toBe(makeBatchKey(idn));
  });
});
