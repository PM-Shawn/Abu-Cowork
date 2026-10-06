import { useLayoutEffect, useRef, type FocusEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { MAX_VISIBLE_TOASTS, type Toast } from '@/stores/toastStore';
import { Button, IconButton } from './button';
import { AppIcons } from './icons';
import { useLayerContainer } from './layer-context';
import { StatusIcon } from './status-icon';
import { FLOAT_SURFACE, TOAST_SETTLE_MS } from './styles';

const TONE = { success: 'success', warning: 'warning', error: 'danger', info: 'info' } as const;

const TOAST_MOTION = 'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-2 data-[state=open]:duration-base data-[state=open]:ease-enter';

// The newest notifications, newest first: the order they are drawn in, from the top.
const newestFirst = (toasts: Toast[]) => toasts.slice(-MAX_VISIBLE_TOASTS).reverse();

// Shows the notifications it is given: the newest three, the newest on top. (The app's store keeps
// the ones pushed out, with their time, and hands them back when a place frees.) The list sits at
// the top centre of the window: measured, this place covers no approval button and keeps the newest
// one's title and close button clear of the native browser view, which fills the right panel below
// the tab row. The page order is the drawn order, so Tab walks the list from the top. The list is
// not a layer and never takes Escape, so Escape keeps closing whatever dialog is open.
// The live region wraps the list and is not atomic, so only a new notification is read.
// Radix turns pointer input off on <body> while a modal dialog is open; each notification turns it
// back on for itself (`pointer-events-auto`), so Close and an action such as Undo can be pressed then
// too. The list's own box does not, so a press between two notifications goes to what is under it.
// A dialog does not take a press on a notification for a press outside it (`data-ds-toasts`, read in Dialog).
export function Toaster({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  const { t } = useI18n();
  const container = useLayerContainer();
  const listRef = useRef<HTMLOListElement>(null);
  // The last notification the user dismissed, and how: a click raised by Enter or Space reports detail 0.
  const dismissed = useRef<{ id: string; index: number; keyboard: boolean } | null>(null);
  // The notification that holds the focus, and what had the focus before it entered the list.
  // A notification never takes the focus by itself; a press on one of its buttons or Tab brings it here.
  const held = useRef<{ id: string; returnTo: HTMLElement | null } | null>(null);
  // The drawn order at the last change, and until when each notification takes no pointer press.
  const arrangement = useRef<string[]>([]);
  const settling = useRef(new Map<string, number>());
  const visible = newestFirst(toasts);

  // A notification that arrives takes the top place and moves the others down; one that leaves
  // lets the ones below it move up. A press aimed at one notification's button must not land on
  // another's (two sandbox notifications have the same buttons at the same places), so a
  // notification that has just appeared or moved takes no pointer press for TOAST_SETTLE_MS. One
  // with the same notifications above it as before has not moved and is not held back. The
  // keyboard is not held back: the focus says which button is meant. It is a guard, not a state,
  // so nothing looks disabled.
  useLayoutEffect(() => {
    const order = newestFirst(toasts).map((toast) => toast.id);
    const before = arrangement.current;
    const until = Date.now() + TOAST_SETTLE_MS;
    const next = new Map<string, number>();
    order.forEach((id, index) => {
      const was = before.indexOf(id);
      const moved = was !== index || before.slice(0, was).join('\u0000') !== order.slice(0, index).join('\u0000');
      const earlier = settling.current.get(id);
      if (moved) next.set(id, until);
      else if (earlier !== undefined) next.set(id, earlier);
    });
    settling.current = next;
    arrangement.current = order;
  }, [toasts]);

  // The notification that held the focus has left (dismissed or expired):
  // the focus must not stay on the window. After a pointer press it goes back to what had it before.
  // From the keyboard, or when the notification left by itself, it goes to the close button now at
  // its place, or the newest one, and back to what had it once the list is empty.
  useLayoutEffect(() => {
    const shown = newestFirst(toasts);
    const last = dismissed.current;
    const hold = held.current;
    const lastGone = last !== null && !toasts.some((toast) => toast.id === last.id);
    const holdGone = hold !== null && !shown.some((toast) => toast.id === hold.id);
    if (lastGone) dismissed.current = null;
    if (holdGone) held.current = null;
    const byKeyboard = lastGone && last.keyboard;
    if (!holdGone && !byKeyboard) return;
    // The focus is already somewhere (the user moved it, or a dialog took it): it stays there.
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const returnTo = holdGone ? hold.returnTo : null;
    const byPointer = lastGone && !last.keyboard && holdGone && last.id === hold.id;
    const closeButtons = listRef.current?.querySelectorAll<HTMLButtonElement>('[data-toast-close]');
    if (!byPointer && closeButtons && closeButtons.length > 0) {
      const at = Math.min(lastGone ? last.index : 0, closeButtons.length - 1);
      held.current = { id: shown[at].id, returnTo };
      closeButtons[at].focus();
      return;
    }
    if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
  }, [toasts]);

  // A pointer press on a notification that is still settling: dropped.
  const isSettling = (id: string, event: MouseEvent) => event.detail !== 0 && Date.now() < (settling.current.get(id) ?? 0);

  const dismiss = (id: string, index: number, event: MouseEvent) => {
    if (isSettling(id, event)) return;
    dismissed.current = { id, index, keyboard: event.detail === 0 };
    onDismiss(id);
  };

  const onToastFocus = (id: string, event: FocusEvent<HTMLLIElement>) => {
    const hold = held.current;
    if (hold) {
      // The focus moved inside the list, or the window got the OS focus back.
      held.current = { id, returnTo: hold.returnTo };
      return;
    }
    const from = event.relatedTarget;
    held.current = { id, returnTo: from instanceof HTMLElement ? from : null };
  };

  const onListBlur = (event: FocusEvent<HTMLElement>) => {
    const hold = held.current;
    if (!hold) return;
    const list = event.currentTarget;
    const to = event.relatedTarget;
    if (to instanceof Node && list.contains(to)) return;
    if (to !== null) {
      held.current = null;
      return;
    }
    // No next element: the notification is being removed (the effect above runs first, in this same
    // task), the window lost the OS focus (the focus stays in the list), or the user pressed the page.
    queueMicrotask(() => {
      if (held.current === hold && !list.contains(document.activeElement)) held.current = null;
    });
  };

  return createPortal(
    <section
      aria-label={t.designSystem.notifications}
      data-ds-toasts
      data-electron-no-drag
      className="pointer-events-none fixed top-4 left-1/2 z-toast w-80 -translate-x-1/2"
      onBlur={onListBlur}
    >
      <div aria-live="polite" aria-atomic="false">
        <ol ref={listRef} className="flex flex-col gap-2">
          {visible.map((toast, index) => (
            <li
              key={toast.id}
              data-ds-motion
              data-state="open"
              className={cn('pointer-events-auto flex items-start gap-2 p-3', FLOAT_SURFACE, TOAST_MOTION)}
              onFocus={(event) => onToastFocus(toast.id, event)}
            >
              <StatusIcon tone={TONE[toast.type]} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="break-words text-ui font-medium text-label">{toast.title}</p>
                {toast.message && <p className="mt-1 max-h-32 overflow-y-auto break-words text-ui-sm text-label-secondary">{toast.message}</p>}
                {toast.actions && toast.actions.length > 0 && (
                  <div className="mt-2 flex gap-2">
                    {toast.actions.map((action) => (
                      <Button
                        key={action.label}
                        size="sm"
                        onClick={(event) => {
                          if (isSettling(toast.id, event)) return;
                          action.onClick();
                          dismiss(toast.id, index, event);
                        }}
                      >
                        {action.label}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
              <IconButton
                icon={AppIcons.close}
                label={t.common.close}
                size="sm"
                data-toast-close
                onClick={(event) => dismiss(toast.id, index, event)}
              />
            </li>
          ))}
        </ol>
      </div>
    </section>,
    container ?? document.body,
  );
}
