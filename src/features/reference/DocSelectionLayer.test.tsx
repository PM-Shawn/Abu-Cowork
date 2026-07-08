// src/features/reference/DocSelectionLayer.test.tsx
//
// Integration test: selection → toolbar → reference lands in chatStore.pendingReferences
// RTL fallback (Task 11): web-mode preview needs Tauri fs so we use RTL + happy-dom.
//
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { DocSelectionLayer } from './DocSelectionLayer';
import { useChatStore } from '@/stores/chatStore';

// --- Helpers -----------------------------------------------------------------

/** Create a DOM selection covering the full contents of `el`. */
function selectElement(el: Element): void {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

// --- Tests -------------------------------------------------------------------

describe('DocSelectionLayer integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Reset chatStore pending references before every test
    useChatStore.setState({ pendingReferences: [] });
    // Reset DOM body so selections from prior tests don't leak
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
    // Clear any lingering selection
    window.getSelection()?.removeAllRanges();
  });

  // ── Case 1: Add to Chat ───────────────────────────────────────────────────

  it('adds a reference without comment when "Add to Chat" is clicked', async () => {
    render(
      <DocSelectionLayer filePath="/w/订单数据流转说明.md">
        <p>本文档用于定义订单在核心业务链路中的状态流转规则。</p>
      </DocSelectionLayer>,
    );

    // Select the <p> contents
    const para = screen.getByText('本文档用于定义订单在核心业务链路中的状态流转规则。');
    selectElement(para);

    // Dispatch mouseup on the layer container; useTextSelection listens there
    const layer = document.querySelector('[data-doc-selection-layer]')!;
    fireEvent.mouseUp(layer);

    // Advance past the 120 ms debounce → toolbar should appear
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    // Toolbar button "Add to Chat" must be visible (en-US locale)
    const addBtn = screen.getByText('Add to Chat');
    expect(addBtn).toBeInTheDocument();

    // Click it
    fireEvent.click(addBtn);

    // Assert reference landed in the store
    const refs = useChatStore.getState().pendingReferences;
    expect(refs).toHaveLength(1);
    expect(refs[0].source.name).toBe('订单数据流转说明.md');
    expect(refs[0].selection.text).toContain('核心业务链路');
    expect(refs[0].comment).toBeUndefined();
  });

  // ── Case 2: Comment to Chat ───────────────────────────────────────────────

  it('adds a reference with a comment when "Comment to Chat" is used', async () => {
    render(
      <DocSelectionLayer filePath="/w/订单数据流转说明.md">
        <p>本文档用于定义订单在核心业务链路中的状态流转规则。</p>
      </DocSelectionLayer>,
    );

    // Select the <p> contents
    const para = screen.getByText('本文档用于定义订单在核心业务链路中的状态流转规则。');
    selectElement(para);

    const layer = document.querySelector('[data-doc-selection-layer]')!;
    fireEvent.mouseUp(layer);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    // Click "Comment to Chat" → opens CommentEditor
    const commentBtn = screen.getByText('Comment to Chat');
    expect(commentBtn).toBeInTheDocument();
    fireEvent.click(commentBtn);

    // A textarea with the comment placeholder must appear
    const textarea = screen.getByPlaceholderText('Enter your comment…') as HTMLTextAreaElement;
    expect(textarea).toBeInTheDocument();

    // Type a comment and submit via Enter
    fireEvent.change(textarea, { target: { value: '优化这段' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    // Assert reference landed in the store with the comment
    const refs = useChatStore.getState().pendingReferences;
    expect(refs).toHaveLength(1);
    expect(refs[0].comment).toBe('优化这段');
    expect(refs[0].source.name).toBe('订单数据流转说明.md');
    expect(refs[0].selection.text).toContain('核心业务链路');
  });
});
