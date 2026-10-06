import { useLayoutEffect, useRef, type FocusEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type { Toast } from '@/stores/toastStore';
import { Button, IconButton } from './button';
import { AppIcons } from './icons';
import { useLayerContainer } from './layer-context';
import { StatusIcon } from './status-icon';
import { FLOAT_SURFACE } from './styles';

export const MAX_VISIBLE_TOASTS = 3;

const TONE = { success: 'success', warning: 'warning', error: 'danger', info: 'info' } as const;

const TOAST_MOTION = 'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom-2 data-[state=open]:duration-base data-[state=open]:ease-enter';

// Shows toastStore's notifications; the store decides when each one expires. The list is
// not a layer and never takes Escape, so Escape keeps closing whatever dialog is open.
// The live region wraps the list and is not atomic, so only a new notification is read.
// Radix turns pointer input off on <body> while a modal dialog is open; the list turns it back on
// for itself (`pointer-events-auto`), so Close and an action such as Undo can be pressed then too.
// A dialog does not take such a press for a press outside it (`data-ds-toasts`, read in Dialog).
export function Toaster({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  const { t } = useI18n();
  const container = useLayerContainer();
  const listRef = useRef<HTMLOListElement>(null);
  // The last notification the user dismissed, and how: a click raised by Enter or Space reports detail 0.
  const dismissed = useRef<{ id: string; index: number; keyboard: boolean } | null>(null);
  // The notification that holds the focus, and what had the focus before it entered the list.
  // A notification never takes the focus by itself; a press on one of its buttons or Tab brings it here.
  const held = useRef<{ id: string; returnTo: HTMLElement | null } | null>(null);
  const visible = toasts.slice(-MAX_VISIBLE_TOASTS);

  // The notification that held the focus has left (dismissed, expired, or pushed out by newer ones):
  // the focus must not stay on the window. After a pointer press it goes back to what had it before.
  // From the keyboard, or when the notification left by itself, it goes to the close button now at
  // its place, or the newest one left, and back to what had it once the list is empty.
  useLayoutEffect(() => {
    const shown = toasts.slice(-MAX_VISIBLE_TOASTS);
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
      const at = Math.min(lastGone ? last.index : closeButtons.length - 1, closeButtons.length - 1);
      held.current = { id: shown[at].id, returnTo };
      closeButtons[at].focus();
      return;
    }
    if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
  }, [toasts]);

  const dismiss = (id: string, index: number, event: MouseEvent) => {
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
      className="pointer-events-auto fixed bottom-4 right-4 z-toast w-80"
      onBlur={onListBlur}
    >
      <div aria-live="polite" aria-atomic="false">
        <ol ref={listRef} className="flex flex-col gap-2">
          {visible.map((toast, index) => (
            <li
              key={toast.id}
              data-ds-motion
              data-state="open"
              className={cn('flex items-start gap-2 p-3', FLOAT_SURFACE, TOAST_MOTION)}
              onFocus={(event) => onToastFocus(toast.id, event)}
            >
              <StatusIcon tone={TONE[toast.type]} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="break-words text-ui font-medium text-label">{toast.title}</p>
                {toast.message && <p className="mt-1 break-words text-ui-sm text-label-secondary">{toast.message}</p>}
                {toast.actions && toast.actions.length > 0 && (
                  <div className="mt-2 flex gap-2">
                    {toast.actions.map((action) => (
                      <Button
                        key={action.label}
                        size="sm"
                        onClick={(event) => {
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
