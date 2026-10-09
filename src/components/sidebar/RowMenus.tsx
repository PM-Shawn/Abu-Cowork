import { useCallback, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { ContextMenu } from '@/components/ds/context-menu';
import { Menu } from '@/components/ds/menu';
import { isWorking } from '@/components/ds/styles';

interface AnchorBox {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface MoreMenu {
  rowId: string;
  // The row's button the menu was opened from; the focus goes back to it.
  button: HTMLElement;
  anchor: AnchorBox;
}

export interface RowMenuControls {
  /** Whether the "more actions" menu is open for this row. */
  isMoreOpen: (rowId: string) => boolean;
  /** For the row element: a right-click on it opens the list's menu for this row. */
  onRowContextMenu: (event: MouseEvent<HTMLElement>, rowId: string) => void;
  /** For the row element: a touch or a pen held down on it opens the list's menu for this row. */
  onRowPointerDown: (event: PointerEvent<HTMLElement>, rowId: string) => void;
  /** For the row's "more actions" button: opens the list's menu at that button. */
  moreButtonProps: (rowId: string) => {
    'aria-haspopup': 'menu';
    'aria-expanded': boolean;
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
    onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  };
}

// Right-clicks that reached a row on their way up to the list.
const rowRightClicks = new WeakSet<Event>();

// Per list (its `data-row-menus` frame): the row under the gesture that can open the list's
// right-click menu next. The menu opens from a right-click event, and from a touch or a pen
// that stays down, which sends no event when its time is up: each opening shows the row its
// own gesture began on.
const gestureRows = new WeakMap<Element, string>();

function frameOf(element: Element): Element {
  const frame = element.closest('[data-row-menus]');
  if (!frame) throw new Error('A row and its "more actions" button must sit inside their RowMenus');
  return frame;
}

const NO_ANCHOR: AnchorBox = { top: 0, left: 0, width: 0, height: 0 };

// Every mounted menu listens for each key press on the document, so a list of rows
// shares two menus: one right-click menu around the list, and one "more actions" menu
// that opens at the button of the row it is asked for. Both show the items of that row.
export function RowMenus({ items, moreLabel, onOpenChange, onCloseAutoFocus, className, children }: {
  items: (rowId: string) => ReactNode;
  // The name of the rows' "more actions" buttons; the menu they open carries it too.
  moreLabel: string;
  // Either menu opened or closed.
  onOpenChange?: (open: boolean) => void;
  // Either menu has gone; preventDefault() keeps the focus for what the caller opens.
  onCloseAutoFocus?: (event: Event) => void;
  className?: string;
  children: (controls: RowMenuControls) => ReactNode;
}) {
  const [contextRow, setContextRow] = useState<string | null>(null);
  const [more, setMore] = useState<MoreMenu | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);

  const frame = useRef<HTMLDivElement>(null);

  const onRowContextMenu = useCallback((event: MouseEvent<HTMLElement>, rowId: string) => {
    rowRightClicks.add(event.nativeEvent);
    gestureRows.set(frameOf(event.currentTarget), rowId);
  }, []);

  const onRowPointerDown = useCallback((event: PointerEvent<HTMLElement>, rowId: string) => {
    if (event.pointerType !== 'mouse') gestureRows.set(frameOf(event.currentTarget), rowId);
  }, []);

  const gestureRow = () => (frame.current ? gestureRows.get(frame.current) ?? null : null);

  const handleContextOpenChange = (open: boolean) => {
    if (open) setContextRow(gestureRow());
    onOpenChange?.(open);
  };

  const openMoreAt = (rowId: string, button: HTMLElement) => {
    const frame = frameOf(button);
    const origin = frame.getBoundingClientRect();
    const box = button.getBoundingClientRect();
    setMore({
      rowId,
      button,
      anchor: { top: box.top - origin.top, left: box.left - origin.left, width: box.width, height: box.height },
    });
    setMoreOpen(true);
    onOpenChange?.(true);
  };

  const handleMoreOpenChange = (open: boolean) => {
    setMoreOpen(open);
    onOpenChange?.(open);
  };

  const controls: RowMenuControls = {
    isMoreOpen: (rowId) => moreOpen && more?.rowId === rowId,
    onRowContextMenu,
    onRowPointerDown,
    moreButtonProps: (rowId) => ({
      'aria-haspopup': 'menu',
      'aria-expanded': moreOpen && more?.rowId === rowId,
      // Like a menu button: the press opens the menu, and the row behind does not act on it.
      onPointerDown: (event) => {
        if (event.button !== 0 || event.ctrlKey) return;
        // A button its list marks as working (`aria-disabled`) is no menu button for now.
        if (isWorking(event.currentTarget)) return;
        event.preventDefault();
        openMoreAt(rowId, event.currentTarget);
      },
      onKeyDown: (event) => {
        if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'ArrowDown') return;
        // Prevented also for a repeat, so the browser makes no click from a held Enter or Space.
        event.preventDefault();
        // One press opens once. The focus is handed to this button after a row's action, and a
        // key that is still down then must open nothing.
        if (event.repeat || isWorking(event.currentTarget)) return;
        openMoreAt(rowId, event.currentTarget);
      },
      onClick: (event) => {
        event.stopPropagation();
        // A screen reader activates the button with a click alone (`detail` 0: no pointer went
        // down for it, and the opening keys make no click): that click opens the menu. The click
        // of a pointer press counts its presses and is left to the pointer-down above.
        if (event.detail !== 0 || event.defaultPrevented) return;
        if (isWorking(event.currentTarget)) return;
        if (moreOpen && more?.rowId === rowId) return;
        openMoreAt(rowId, event.currentTarget);
      },
    }),
  };

  return (
    <div ref={frame} data-row-menus className="relative">
      <ContextMenu
        content={contextRow ? items(contextRow) : null}
        // A long press between the rows, or on a row that reports no presses, has no row.
        canOpen={() => gestureRow() !== null}
        onOpenChange={handleContextOpenChange}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <div
          className={className}
          // A new touch or pen press starts with no row; the row it lands on reports itself next.
          onPointerDownCapture={(event) => { if (event.pointerType !== 'mouse') gestureRows.delete(frameOf(event.currentTarget)); }}
          // The menu writes its open state on its trigger, and a changed attribute here
          // makes the browser restyle every row below. Nothing reads it, so the list declines it.
          data-state={undefined}
          // Only a right-click that came through a row opens the menu.
          onContextMenu={(event) => { if (!rowRightClicks.has(event.nativeEvent)) event.preventDefault(); }}
        >
          {children(controls)}
        </div>
      </ContextMenu>
      <Menu
        open={moreOpen}
        onOpenChange={handleMoreOpenChange}
        onCloseAutoFocus={onCloseAutoFocus}
        trigger={(
          // Stands where the row's button is, so the menu opens there, and names the menu
          // (a menu takes its name from its trigger). The menu gives the focus back to its
          // trigger when it closes; this one hands it on to that button, or to the first
          // row left when the button's row has gone in the meantime.
          <span
            aria-hidden="true"
            aria-label={moreLabel}
            tabIndex={-1}
            onFocus={(event) => {
              if (more?.button.isConnected) {
                more.button.focus();
                return;
              }
              const firstRow = event.currentTarget.closest('[data-row-menus]')?.querySelector<HTMLElement>('[tabindex="0"]');
              if (firstRow) firstRow.focus();
              else event.currentTarget.blur();
            }}
            className="pointer-events-none absolute"
            style={more?.anchor ?? NO_ANCHOR}
          />
        )}
      >
        {more ? items(more.rowId) : null}
      </Menu>
    </div>
  );
}
