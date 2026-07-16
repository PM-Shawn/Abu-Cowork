import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Centered detail modal chrome for the toolbox card grid — harvested from the
 * former ExpertDetailModal. Purely presentational: backdrop + Esc close, close
 * X, and header / body / footer slots. Each tab injects its own detail JSX so
 * business state stays in the owning section.
 */
export interface ToolDetailModalProps {
  open: boolean;
  onClose: () => void;
  avatar?: ReactNode;
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Header-row actions to the left of the close X (toggle, menu, primary CTA). */
  headerActions?: ReactNode;
  /** Sticky footer (e.g. a full-width primary CTA). */
  footer?: ReactNode;
  children: ReactNode;
  /** Tailwind max-width class for the panel. */
  maxWidth?: string;
  /** Suppress the Escape-to-close handler — e.g. while a nested modal (skill
   *  history) is stacked on top and should own the Escape key. */
  disableEscape?: boolean;
}

export default function ToolDetailModal({
  open,
  onClose,
  avatar,
  title,
  subtitle,
  headerActions,
  footer,
  children,
  maxWidth = 'max-w-lg',
  disableEscape = false,
}: ToolDetailModalProps) {
  // Escape to close — suppressed when a nested modal owns Escape.
  useEffect(() => {
    if (!open || disableEscape) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, disableEscape, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className={cn(
          'relative bg-[var(--abu-bg-base)] rounded-2xl shadow-2xl w-full max-h-[85vh] flex flex-col overflow-hidden border border-[var(--abu-border)]',
          maxWidth
        )}
      >
        {/* Header: avatar + title/subtitle · actions + close */}
        <div className="shrink-0 flex items-start justify-between gap-3 px-6 pt-6 pb-4">
          <div className="flex items-start gap-4 min-w-0">
            {avatar && (
              <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-[var(--abu-bg-active)] text-3xl shrink-0 select-none">
                {avatar}
              </div>
            )}
            <div className="min-w-0 pt-1">
              {title && (
                <h2 className="text-lg font-semibold text-[var(--abu-text-primary)] leading-snug truncate">
                  {title}
                </h2>
              )}
              {subtitle && (
                <div className="mt-0.5 text-sm text-[var(--abu-text-tertiary)]">{subtitle}</div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {headerActions}
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-active)] transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto overlay-scroll px-6 pb-6">
          {children}
        </div>

        {/* Sticky footer */}
        {footer && (
          <div className="shrink-0 px-6 pb-6 pt-3 border-t border-[var(--abu-border)]">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
