import { useCallback, useLayoutEffect, useRef } from 'react';
import { lastInputWasPointer } from '@/components/ds/input-modality';
import { focusIsOnWindow } from '@/components/toolbox/cardFocus';

/**
 * Keyboard focus for the project rows of the sidebar. A row leaves the list when its project is
 * archived or deleted, from the row's own menu or from the project settings window it opened.
 * The focus then goes to the row that took its place, else the one before it, else the button
 * that creates a project, so it never ends up on the window.
 *
 * The card helper of the extensions pages does not fit here: it looks for a `role="button"`
 * inside a card holder, and a project row is a native button that is its own focus target. The
 * list helper of the todos page moves the focus in the render after the action, when a
 * question or a window that is still leaving the page holds it.
 */

const ROW = 'data-project-row';
const CREATE = 'data-project-create';

export interface ProjectRowPlace {
  id: string;
  /** Where the row sat among the project rows when it was noted, or -1. */
  index: number;
}

/** Spread on the button that is a project's row; `id` is how the row is found again. */
export function projectRowProps(id: string): Record<string, string> {
  return { [ROW]: id };
}

/** Spread on the button that creates a project. */
export const projectCreateProps: Record<string, string> = { [CREATE]: '' };

const rows = () => Array.from(document.querySelectorAll<HTMLElement>(`[${ROW}]`));

/** The row as it is now, with its place among the project rows. */
export function projectRowPlace(id: string): ProjectRowPlace {
  return { id, index: rows().findIndex((row) => row.getAttribute(ROW) === id) };
}

/**
 * Focuses the row; once it has gone, the row now at its place, else the last one, else the
 * create button. False when the page shows none of them (the sidebar is on its file tree).
 */
export function focusProjectRow(place: ProjectRowPlace): boolean {
  const all = rows();
  const row = all.find((candidate) => candidate.getAttribute(ROW) === place.id)
    ?? (place.index >= 0 ? all[Math.min(place.index, all.length - 1)] : undefined);
  if (row) {
    row.focus(lastInputWasPointer() ? { focusVisible: false } : undefined);
    return true;
  }
  const create = document.querySelector<HTMLElement>(`[${CREATE}]`);
  // The create button shows under the pointer or with a visible focus only.
  create?.focus({ focusVisible: true });
  return create !== null;
}

/**
 * For the owner of the rows. Call the returned function right before a row's project is
 * archived or deleted: once the row has left and the question that was asked about it has gone,
 * the focus moves on from the window.
 */
export function useProjectRowFocus(): (id: string) => void {
  const leaving = useRef<ProjectRowPlace | null>(null);
  const note = useCallback((id: string) => { leaving.current = projectRowPlace(id); }, []);
  // After every render: the row noted in a handler is gone by the render that follows the store change.
  useLayoutEffect(() => {
    const place = leaving.current;
    if (!place || rows().some((row) => row.getAttribute(ROW) === place.id)) return;
    leaving.current = null;
    if (focusIsOnWindow()) focusProjectRow(place);
  });
  return note;
}
