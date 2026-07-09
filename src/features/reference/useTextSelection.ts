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
  /** When false, selection tracking is paused (e.g. while a comment editor —
   *  which lives inside the container — is open and steals the selection). */
  enabled?: boolean;
  debounceMs?: number;
}

export function useTextSelection({ containerRef, onSelect, enabled = true, debounceMs = 120 }: Options): void {
  const onSelectRef = useRef(onSelect);
  // Sync refs during render to avoid stale closure — useEffect would leave a timing
  // gap. `enabled` MUST be read synchronously: the pause has to be in effect before
  // the comment editor's focus() fires selectionchange, which happens in a child
  // effect (post-commit) — a state-based gate would arrive one tick too late.
  // eslint-disable-next-line react-hooks/refs
  onSelectRef.current = onSelect;
  const enabledRef = useRef(enabled);
  // eslint-disable-next-line react-hooks/refs
  enabledRef.current = enabled;

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

    const onMouseUp = (e: MouseEvent) => {
      // Ignore mouseups inside the toolbar/comment editor (they live in this
      // container) — only a mouseup on the document should (re)evaluate. This is
      // what lets the user select a DIFFERENT sentence while an editor is open,
      // without clicks inside the editor dismissing it.
      if ((e.target as HTMLElement)?.closest?.('[data-selection-toolbar]')) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(evaluate, debounceMs);
    };
    const onSelectionChange = () => {
      // Paused while a comment editor is open: focusing its textarea collapses
      // the doc selection, and we must NOT treat that as a dismiss.
      if (!enabledRef.current) return;
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
