import { useCallback, useLayoutEffect, useRef } from 'react';
import { lastInputWasPointer } from '@/components/ds/input-modality';
import { focusIsOnWindow } from '@/components/toolbox/cardFocus';

/**
 * Keyboard focus for a list whose rows hold buttons (the todos and the inbox items).
 *
 * A button can leave the page while the focus is on it: its row is deleted, an answered inbox
 * item loses its buttons or leaves the tab, the inline form closes. The focus then goes to the
 * first button of the same row, else of the row that took its place, else of a row before it,
 * else to `fallback` (a control of the page header), so it never ends up on the window.
 *
 * `attribute` is the data attribute every row carries with its id. Put `root` on the element
 * that holds the rows, `fallback` on the header control, and call `note` right before the
 * action that may take the focused control away.
 */
export function useRowFocus(attribute: string) {
  const root = useRef<HTMLDivElement>(null);
  const fallback = useRef<HTMLButtonElement>(null);
  const noted = useRef<{ id: string | null; index: number } | null>(null);

  /** `id` is the row acted on; null when the control that leaves is not in a row. */
  const note = useCallback((id: string | null) => {
    const rows = Array.from(root.current?.querySelectorAll<HTMLElement>(`[${attribute}]`) ?? []);
    noted.current = { id, index: id === null ? -1 : rows.findIndex((row) => row.getAttribute(attribute) === id) };
  }, [attribute]);

  // After every render: the action noted in a handler has been drawn by the next one.
  useLayoutEffect(() => {
    const place = noted.current;
    noted.current = null;
    if (!place || !root.current || !focusIsOnWindow()) return;
    const rows = Array.from(root.current.querySelectorAll<HTMLElement>(`[${attribute}]`));
    const firstButton = (row: HTMLElement | undefined) => row?.querySelector<HTMLElement>('button:not(:disabled)') ?? null;
    const same = place.id === null ? -1 : rows.findIndex((row) => row.getAttribute(attribute) === place.id);
    let target = same >= 0 ? firstButton(rows[same]) : null;
    if (!target && place.index >= 0) {
      const from = same >= 0 ? same + 1 : place.index;
      for (let i = from; i < rows.length && !target; i += 1) target = firstButton(rows[i]);
      for (let i = Math.min(from, rows.length) - 1; i >= 0 && !target; i -= 1) target = firstButton(rows[i]);
    }
    if (!target) {
      target = fallback.current && !fallback.current.disabled
        ? fallback.current
        : root.current.querySelector<HTMLElement>('input, button:not(:disabled)');
    }
    target?.focus(lastInputWasPointer() ? { focusVisible: false } : undefined);
  });

  return { root, fallback, note };
}
