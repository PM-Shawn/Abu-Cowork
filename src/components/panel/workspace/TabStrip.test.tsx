// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
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
    <TooltipProvider>
      <TabStrip />
    </TooltipProvider>,
  );
}

describe('TabStrip pointer interactions', () => {
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

  it('offers a browser tab in the new-tab menu', () => {
    renderTabs();

    fireEvent.click(screen.getByRole('button', { name: 'New tab' }));
    fireEvent.click(screen.getByRole('button', { name: 'New Browser' }));

    expect(usePreviewStore.getState().tabs.at(-1)).toMatchObject({
      kind: 'browser',
      url: '',
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

  it('renders the close control as an adjacent named button', () => {
    renderTabs();

    fireEvent.click(screen.getByRole('button', { name: 'Close Task Summary' }));

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
      <TooltipProvider>
        <button type="button">Outside control</button>
        <TabStrip />
      </TooltipProvider>,
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
