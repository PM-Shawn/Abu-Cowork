import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/** Shared modal shell for team dialogs — copies ConfirmDialog's portal/overlay
 *  pattern (incl. the Windows drag-lane opt-out on the overlay root). */
export default function DialogShell({ open, onClose, title, children, wide }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div data-electron-no-drag className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 animate-in fade-in duration-150" onClick={onClose}>
      <div
        className={`bg-[var(--abu-bg-base)] rounded-2xl shadow-xl border border-[var(--abu-border)] w-full ${wide ? 'max-w-lg' : 'max-w-md'} mx-4 max-h-[85vh] flex flex-col`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <h2 className="text-h-sm text-[var(--abu-text-primary)] truncate pr-2">{title}</h2>
          <button onClick={onClose} className="btn-ghost p-1 rounded-md text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)]" aria-label="close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 pb-5 overflow-y-auto">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
