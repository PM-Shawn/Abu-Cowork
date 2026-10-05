import { useCallback, useLayoutEffect, useRef } from 'react';
import { lastInputWasPointer } from '@/components/ds/input-modality';
import { cardOrNeighbour, focusByTestId, focusIsOnWindow, type CardPlace } from '@/components/toolbox/cardFocus';

/** True when the keyboard focus sits in a window, a question or a list that floats over the page. */
function focusIsInLayer(): boolean {
  return document.activeElement?.closest('[data-ds-layer]') != null;
}

/**
 * Keyboard focus for a list of the automation page and the page of one of its items, which
 * replace each other.
 *
 * When the control that had the focus went away with its page, the focus goes to the new page's
 * way back (on the way in), or to the card of the item just left (on the way back): once that
 * item is deleted, to the card that took its place, else the one before it, else the page's
 * create button. Focus that sits on a control outside the two pages stays.
 *
 * A page can also be replaced while the focus sits in a window opened from it: its delete
 * question or its editor, when the item is deleted by a tool in a conversation, or when a new
 * item is saved from the list. That window gives the focus back to the control that opened it,
 * which has left with its page, so the page owes the focus a place: `afterLayer` (a question)
 * and `editorCloseAutoFocus` (the editor) pay it once the window has gone.
 *
 * `detailId` is the item whose page is in view, or null for the list. `indexOf` gives an item's
 * place in the list; pass a function that stays the same between renders.
 */
export function useListDetailFocus(detailId: string | null, indexOf: (id: string) => number) {
  const root = useRef<HTMLDivElement>(null);
  // The item whose page was in view at the last render, with its place in the list; `undefined`
  // until the first render, which moves no focus.
  const shown = useRef<CardPlace | null | undefined>(undefined);
  // Set while a page was replaced under a floating window: the item whose page left, if any.
  const owed = useRef<{ left: CardPlace | null } | null>(null);

  const move = useCallback((left: CardPlace | null) => {
    if (!root.current) return;
    const options = lastInputWasPointer() ? { focusVisible: false } : undefined;
    if (shown.current) {
      root.current.querySelector<HTMLElement>('[data-automation-back]')?.focus(options);
      return;
    }
    const card = left ? cardOrNeighbour(root.current, 'automation', left.id, left.index) : null;
    if (card) card.focus(options);
    else focusByTestId('automation-create');
  }, []);

  useLayoutEffect(() => {
    const left = shown.current;
    shown.current = detailId ? { id: detailId, index: indexOf(detailId) } : null;
    if (left === undefined || (left?.id ?? null) === detailId || !root.current) return;
    if (!focusIsOnWindow()) {
      owed.current = focusIsInLayer() ? { left } : null;
      return;
    }
    owed.current = null;
    move(left);
  }, [detailId, indexOf, move]);

  /** A question asked from the page has gone. Moves the focus only when the page left meanwhile and the focus fell on the window. */
  const afterLayer = useCallback(() => {
    const debt = owed.current;
    owed.current = null;
    if (debt && focusIsOnWindow()) move(debt.left);
  }, [move]);

  /** For the editor's `onCloseAutoFocus`: looks once the window has given the focus back to whatever opened it. */
  const editorCloseAutoFocus = useCallback((event: Event) => {
    if (event.defaultPrevented || !owed.current) return;
    queueMicrotask(afterLayer);
  }, [afterLayer]);

  return { root, afterLayer, editorCloseAutoFocus };
}
