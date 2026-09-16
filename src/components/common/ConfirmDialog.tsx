import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Plain text in almost every caller. Widened to ReactNode so a caller that
   *  must show a verbatim value (an app-supplied URL, monospace and wrapped)
   *  can render it without a second dialog component. */
  message: ReactNode;
  confirmText: string;
  cancelText: string;
  onConfirm: () => void;
  onCancel: () => void;
  variant?: 'danger' | 'normal';
  /** Blocks the confirm button while the action it triggers is already running.
   *  Cancel and Escape stay live — the dialog must always be dismissable. */
  confirmDisabled?: boolean;
}

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmText,
  cancelText,
  onConfirm,
  onCancel,
  variant = 'normal',
  confirmDisabled = false,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  // Portal to body so the dialog escapes any ancestor containing block —
  // ProviderCard sits inside ScrollArea/transformed parents, and rendering
  // inline made `fixed inset-0` resolve relative to the nearest transformed
  // ancestor instead of the viewport, leaving the dialog mis-positioned and
  // the backdrop clipped.
  return createPortal(
    <div
      data-electron-no-drag
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 animate-in fade-in duration-150"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="bg-[var(--abu-bg-base)] rounded-2xl shadow-xl w-[360px] p-6 animate-in zoom-in-95 duration-150"
      >
        <h3 className="text-h-sm font-semibold text-[var(--abu-text-primary)] mb-2">
          {title}
        </h3>
        <div className="text-body text-[var(--abu-text-tertiary)] leading-relaxed mb-6">
          {message}
        </div>
        <div className="flex items-center justify-end gap-3">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-body font-medium text-[var(--abu-text-tertiary)] hover:bg-[var(--abu-bg-muted)] transition-colors"
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            disabled={confirmDisabled}
            className={cn(
              'px-4 py-2 rounded-lg text-body font-medium text-white transition-colors',
              variant === 'danger'
                ? 'bg-[var(--abu-danger-solid)] hover:opacity-90'
                : 'bg-[var(--abu-clay)] hover:bg-[var(--abu-clay-hover)]',
              confirmDisabled && 'opacity-50 cursor-not-allowed hover:opacity-50'
            )}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
