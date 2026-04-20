/**
 * Click semantics for the pet (Phase C).
 *
 * - Single click → expand mini input (after 260ms debounce to check for
 *   a double-click).
 * - Double click → focus main window.
 * - Right click → show HTML context menu (callers render the menu).
 *
 * Returns handlers + menu state; callers spread handlers onto the
 * draggable surface and render the menu when `menuPos` is non-null.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const DBLCLICK_DELAY_MS = 260;

export interface ContextMenuPos {
  x: number;
  y: number;
}

export interface UseClickMenuArgs {
  onSingleClick: () => void;
  onDoubleClick: () => void;
}

export interface UseClickMenuResult {
  menuPos: ContextMenuPos | null;
  closeMenu: () => void;
  handlers: {
    onClick: (e: React.MouseEvent) => void;
    onDoubleClick: (e: React.MouseEvent) => void;
    onContextMenu: (e: React.MouseEvent) => void;
  };
}

export function useClickMenu({ onSingleClick, onDoubleClick }: UseClickMenuArgs): UseClickMenuResult {
  const singleTimer = useRef<number | null>(null);
  const [menuPos, setMenuPos] = useState<ContextMenuPos | null>(null);

  const cancelSingle = useCallback(() => {
    if (singleTimer.current !== null) {
      clearTimeout(singleTimer.current);
      singleTimer.current = null;
    }
  }, []);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      // Defer single-click; onDoubleClick will cancel if it fires.
      cancelSingle();
      singleTimer.current = window.setTimeout(() => {
        singleTimer.current = null;
        onSingleClick();
      }, DBLCLICK_DELAY_MS);
    },
    [onSingleClick, cancelSingle],
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      cancelSingle();
      onDoubleClick();
    },
    [onDoubleClick, cancelSingle],
  );

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setMenuPos({ x: e.clientX, y: e.clientY });
  }, []);

  const closeMenu = useCallback(() => setMenuPos(null), []);

  // Dismiss menu on outside click / Escape.
  useEffect(() => {
    if (!menuPos) return;
    const onDocClick = () => setMenuPos(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuPos(null);
    };
    window.addEventListener('click', onDocClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', onDocClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuPos]);

  // Cleanup timer on unmount.
  useEffect(() => () => cancelSingle(), [cancelSingle]);

  return {
    menuPos,
    closeMenu,
    handlers: {
      onClick: handleClick,
      onDoubleClick: handleDoubleClick,
      onContextMenu: handleContextMenu,
    },
  };
}
