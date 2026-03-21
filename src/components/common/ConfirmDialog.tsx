import { useEffect } from 'react';
import { cn } from '@/lib/utils';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
  onConfirm: () => void;
  onCancel: () => void;
  variant?: 'danger' | 'normal';
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

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 animate-in fade-in duration-150"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="bg-white rounded-2xl shadow-xl w-[360px] p-6 animate-in zoom-in-95 duration-150"
      >
        <h3 className="text-[16px] font-semibold text-[var(--abu-text-primary)] mb-2">
          {title}
        </h3>
        <p className="text-[14px] text-[var(--abu-text-tertiary)] leading-relaxed mb-6">
          {message}
        </p>
        <div className="flex items-center justify-end gap-3">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-[13px] font-medium text-[var(--abu-text-tertiary)] hover:bg-[var(--abu-bg-muted)] transition-colors"
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            className={cn(
              'px-4 py-2 rounded-lg text-[13px] font-medium text-white transition-colors',
              variant === 'danger'
                ? 'bg-red-500 hover:bg-red-600'
                : 'bg-[var(--abu-clay)] hover:bg-[var(--abu-clay-hover)]'
            )}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
