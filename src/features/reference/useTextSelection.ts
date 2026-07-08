// src/features/reference/useTextSelection.ts
import { useEffect, useRef } from 'react';

export interface TextSelectionResult {
  text: string;
  rect: DOMRect;
  range: Range;
}

interface Options {
  containerRef: React.RefObject<HTMLElement | null>;
  onSelect: (result: TextSelectionResult | null) => void;
  debounceMs?: number;
}

export function useTextSelection({ containerRef, onSelect, debounceMs = 120 }: Options): void {
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let timer: ReturnType<typeof setTimeout> | null = null;

    const evaluate = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        onSelectRef.current(null);
        return;
      }
      const text = sel.toString().trim();
      if (!text || !container.contains(sel.anchorNode)) {
        onSelectRef.current(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      onSelectRef.current({ text, rect, range });
    };

    const onMouseUp = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(evaluate, debounceMs);
    };
    const onSelectionChange = () => {
      // Only quickly dismiss on collapse; open selection evaluation waits for mouseup
      // (avoids toolbar flashing while user is still dragging to select).
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) onSelectRef.current(null);
    };

    container.addEventListener('mouseup', onMouseUp);
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      if (timer) clearTimeout(timer);
      container.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('selectionchange', onSelectionChange);
    };
  }, [containerRef, debounceMs]);
}
