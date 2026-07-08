// src/features/reference/useTextSelection.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRef } from 'react';
import { useTextSelection } from './useTextSelection';

function setupContainer(html: string): HTMLDivElement {
  const div = document.createElement('div');
  div.innerHTML = html;
  document.body.appendChild(div);
  return div;
}

describe('useTextSelection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    window.getSelection()?.removeAllRanges();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onSelect with text when a selection is made inside the container', async () => {
    const container = setupContainer('<p class="p">hello world</p>');
    const onSelect = vi.fn();
    renderHook(() => {
      const ref = useRef<HTMLDivElement | null>(container);
      useTextSelection({ containerRef: ref, onSelect });
      return null;
    });
    const p = container.querySelector('.p')!;
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    container.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    // Advance fake timers past debounce delay so evaluate() runs
    await act(async () => { vi.advanceTimersByTime(200); });
    expect(onSelect).toHaveBeenCalled();
    const arg = onSelect.mock.calls.at(-1)![0];
    expect(arg?.text).toContain('hello world');
  });

  it('fires onSelect(null) when selection is collapsed', async () => {
    const container = setupContainer('<p class="p">hi</p>');
    const onSelect = vi.fn();
    renderHook(() => {
      const ref = useRef<HTMLDivElement | null>(container);
      useTextSelection({ containerRef: ref, onSelect });
      return null;
    });
    window.getSelection()!.removeAllRanges();
    container.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await act(async () => { vi.advanceTimersByTime(200); });
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });
});
