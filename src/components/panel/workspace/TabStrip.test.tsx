/// <reference types="@testing-library/jest-dom" />
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { initLanguage } from '@/i18n';
import { usePreviewStore, type WorkspaceTab } from '@/stores/previewStore';
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
    menuOpen: false,
    previewFilePath: null,
  });
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
    seedTabs();
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
});
