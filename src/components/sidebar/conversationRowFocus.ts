import { useLayoutEffect, useMemo, useRef } from 'react';
import { lastInputWasPointer } from '@/components/ds/input-modality';
import { focusIsOnWindow } from '@/components/toolbox/cardFocus';

/**
 * Keyboard focus for the conversation rows of the sidebar. A row leaves its list when its
 * conversation is deleted from the row's menu. The focus then stays in that list: it goes to the
 * row that took its place, else the list's last row, and once the list is empty to the list's
 * home (a project's own row), else the entry that starts a conversation, so it never ends up on
 * the window. The notice that offers to undo the delete is not given the focus.
 *
 * A list is the frame of one `RowMenus`: the recent tasks, and the tasks of each expanded project.
 *
 * The project helper (`projectRowFocus.ts`) acts in the render after the row has gone. A
 * conversation is deleted straight from its menu, with no question in between, so the row can
 * be gone while the menu is still closing with the focus in it: the move then waits for the
 * menu's close hook.
 */

const ROW = 'data-conversation-row';
const LIST = '[data-row-menus]';
const NEW_TASK = '[data-sidebar-action="new-task"]';

/** Spread on the element that is a conversation's row; `id` is how the row is found again. */
export function conversationRowProps(id: string): Record<string, string> {
  return { [ROW]: id };
}

/** Where a row sat when it was noted. */
interface ConversationRowPlace {
  id: string;
  /** The list the row was in, or null for a row outside every list. */
  list: HTMLElement | null;
  /** Its place among the rows of that list, or -1. */
  index: number;
}

const rowsIn = (list: ParentNode) => Array.from(list.querySelectorAll<HTMLElement>(`[${ROW}]`));
const isOnPage = (id: string) => rowsIn(document).some((row) => row.getAttribute(ROW) === id);

/** False when the page shows neither a row of the list, nor its home, nor the entry that starts a conversation. */
function focusAfter(place: ConversationRowPlace, home: HTMLElement | null): boolean {
  const left = place.list === null ? rowsIn(document) : place.list.isConnected ? rowsIn(place.list) : [];
  const target = (place.index >= 0 ? left[Math.min(place.index, left.length - 1)] : undefined)
    ?? (home?.isConnected ? home : null)
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

/**
 * For the owner of one list of rows. The focus moves only when it would otherwise be on the
 * window. `home` gives the control the focus goes to once the list is empty (a project's own
 * row); without it, or once that control has left the page, the entry that starts a conversation.
 */
export function useConversationRowFocus(home?: () => HTMLElement | null): ConversationRowFocus {
  const leaving = useRef<ConversationRowPlace | null>(null);
  const homeOf = useRef(home);
  useLayoutEffect(() => { homeOf.current = home; });
  // After every render: the row noted in a handler is gone by the render that follows the store change.
  useLayoutEffect(() => {
    const place = leaving.current;
    if (!place || isOnPage(place.id)) return;
    // The menu the delete was chosen from is still closing with the focus in it: its close
    // hook moves on from here.
    if (document.activeElement?.closest('[role="menu"]')) return;
    leaving.current = null;
    if (focusIsOnWindow()) focusAfter(place, homeOf.current?.() ?? null);
  });
  return useMemo(() => ({
    note: (id) => {
      const row = rowsIn(document).find((candidate) => candidate.getAttribute(ROW) === id);
      const list = row?.closest<HTMLElement>(LIST) ?? null;
      leaving.current = { id, list, index: row ? rowsIn(list ?? document).indexOf(row) : -1 };
    },
    forget: () => { leaving.current = null; },
    afterMenuClose: (event) => {
      const place = leaving.current;
      if (!place || isOnPage(place.id)) return;
      leaving.current = null;
      if (focusAfter(place, homeOf.current?.() ?? null)) event.preventDefault();
    },
  }), []);
}
