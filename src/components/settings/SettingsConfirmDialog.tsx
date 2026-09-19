import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';

interface SettingsConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmText: string;
  cancelText: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmDisabled?: boolean;
  hideCancel?: boolean;
  variant?: 'danger' | 'normal';
}

/**
 * Confirmation surface owned by Settings.
 *
 * Settings itself closes on Escape, so this dialog captures the key before
 * the parent sees it. It also owns focus while open and returns focus to the
 * control that opened it. Keep those behaviours here rather than relying on
 * the older shared ConfirmDialog, whose callers do not all need a modal focus
 * contract yet.
 */
export default function SettingsConfirmDialog({
  open,
  title,
  message,
  confirmText,
  cancelText,
  onConfirm,
  onCancel,
  confirmDisabled = false,
  hideCancel = false,
  variant = 'normal',
}: SettingsConfirmDialogProps) {
  const titleId = useId();
  const messageId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef(onCancel);

  useEffect(() => {
    cancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancelRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      // A pending action can disable the button that still owns focus. Treat
      // that, body, and any outside element as entering the trap, rather than
      // letting the browser continue to the Settings controls behind it.
      if (!focusable.includes(active as HTMLElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    // Window capture runs before the Settings and task-setup document
    // listeners, so one Escape cannot close both this confirmation and its
    // parent surface.
    window.addEventListener('keydown', onKeyDown, true);
    (cancelButtonRef.current ?? dialogRef.current?.querySelector<HTMLElement>('button:not(:disabled)'))?.focus();
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      data-electron-no-drag
      className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/40 p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        tabIndex={-1}
        className="w-[min(420px,92vw)] rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-base)] p-6 shadow-2xl"
      >
        <h3 id={titleId} className="mb-2 text-h-sm font-semibold text-[var(--abu-text-primary)]">
          {title}
        </h3>
        <div id={messageId} className="mb-6 text-body leading-relaxed text-[var(--abu-text-tertiary)]">
          {message}
        </div>
        <div className="flex items-center justify-end gap-3">
          {!hideCancel && <Button
            ref={cancelButtonRef}
            type="button"
            onClick={onCancel}
            variant="ghost"
          >
            {cancelText}
          </Button>}
          <Button
            type="button"
            onClick={onConfirm}
            disabled={confirmDisabled}
            variant={variant === 'danger' ? 'destructive' : 'default'}
          >
            {confirmText}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
