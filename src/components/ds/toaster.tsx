import { useLayoutEffect, useRef, type MouseEvent } from 'react';
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
  // Set when a notification is dismissed from the keyboard; focus then moves to the
  // close button now at its place, or the newest one left.
  const pendingFocus = useRef<{ id: string; index: number } | null>(null);
  const visible = toasts.slice(-MAX_VISIBLE_TOASTS);

  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending || toasts.some((toast) => toast.id === pending.id)) return;
    pendingFocus.current = null;
    const closeButtons = listRef.current?.querySelectorAll<HTMLButtonElement>('[data-toast-close]');
    if (!closeButtons || closeButtons.length === 0) return;
    closeButtons[Math.min(pending.index, closeButtons.length - 1)].focus();
  }, [toasts]);

  const dismiss = (id: string, index: number, event: MouseEvent) => {
    // A click raised by Enter or Space reports detail 0.
    if (event.detail === 0) pendingFocus.current = { id, index };
    onDismiss(id);
  };

  return createPortal(
    <section aria-label={t.designSystem.notifications} data-ds-toasts data-electron-no-drag className="pointer-events-auto fixed bottom-4 right-4 z-toast w-80">
      <div aria-live="polite" aria-atomic="false">
        <ol ref={listRef} className="flex flex-col gap-2">
          {visible.map((toast, index) => (
            <li key={toast.id} data-ds-motion data-state="open" className={cn('flex items-start gap-2 p-3', FLOAT_SURFACE, TOAST_MOTION)}>
              <StatusIcon tone={TONE[toast.type]} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="text-ui font-medium text-label">{toast.title}</p>
                {toast.message && <p className="mt-1 text-ui-sm text-label-secondary">{toast.message}</p>}
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
