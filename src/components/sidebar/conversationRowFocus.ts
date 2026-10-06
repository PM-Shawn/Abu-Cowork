import { useLayoutEffect, useMemo, useRef } from 'react';
import { lastInputWasPointer } from '@/components/ds/input-modality';
import { focusIsOnWindow } from '@/components/toolbox/cardFocus';
import type { ProjectRowPlace } from './projectRowFocus';

/**
 * Keyboard focus for the conversation rows of the sidebar. A row leaves the list when its
 * conversation is deleted from the row's menu. The focus then goes to the row that took its
 * place, else the one before it, else the entry that starts a conversation, so it never ends up
 * on the window. The notice that offers to undo the delete is not given the focus.
 *
 * The project helper (`projectRowFocus.ts`) acts in the render after the row has gone. A
 * conversation is deleted straight from its menu, with no question in between, so the row can
 * be gone while the menu is still closing with the focus in it: the move then waits for the
 * menu's close hook.
 */

const ROW = 'data-conversation-row';
const NEW_TASK = '[data-sidebar-action="new-task"]';

/** Spread on the element that is a conversation's row; `id` is how the row is found again. */
export function conversationRowProps(id: string): Record<string, string> {
  return { [ROW]: id };
}

const rows = () => Array.from(document.querySelectorAll<HTMLElement>(`[${ROW}]`));
const isOnPage = (id: string) => rows().some((row) => row.getAttribute(ROW) === id);

/** False when the page shows neither a row nor the entry that starts a conversation. */
function focusAfter(place: ProjectRowPlace): boolean {
  const all = rows();
  const target = (place.index >= 0 ? all[Math.min(place.index, all.length - 1)] : undefined)
    ?? document.querySelector<HTMLElement>(NEW_TASK);
  target?.focus(lastInputWasPointer() ? { focusVisible: false } : undefined);
  return target !== null && target !== undefined;
}

export interface ConversationRowFocus {
  /** Call right before a row's conversation is deleted. */
  note: (id: string) => void;
  /** A row menu opened: a row noted for a menu that never finished closing is dropped. */
  forget: () => void;
  /**
   * For the row menus' close hook. When the noted row has gone meanwhile, the focus goes on from
   * it and `event.preventDefault()` keeps the menu from handing it elsewhere.
   */
  afterMenuClose: (event: Event) => void;
}

/** For the owner of the rows. The focus moves only when it would otherwise be on the window. */
export function useConversationRowFocus(): ConversationRowFocus {
  const leaving = useRef<ProjectRowPlace | null>(null);
  // After every render: the row noted in a handler is gone by the render that follows the store change.
  useLayoutEffect(() => {
    const place = leaving.current;
    if (!place || isOnPage(place.id)) return;
    // The menu the delete was chosen from is still closing with the focus in it: its close
    // hook moves on from here.
    if (document.activeElement?.closest('[role="menu"]')) return;
    leaving.current = null;
    if (focusIsOnWindow()) focusAfter(place);
  });
  return useMemo(() => ({
    note: (id) => {
      leaving.current = { id, index: rows().findIndex((row) => row.getAttribute(ROW) === id) };
    },
    forget: () => { leaving.current = null; },
    afterMenuClose: (event) => {
      const place = leaving.current;
      if (!place || isOnPage(place.id)) return;
      leaving.current = null;
      if (focusAfter(place)) event.preventDefault();
    },
  }), []);
}
