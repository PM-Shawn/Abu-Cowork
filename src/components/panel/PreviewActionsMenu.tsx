import { useEffect, useRef, useState } from 'react';
import { Copy, FolderOpen, MoreHorizontal, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface PreviewActionsMenuProps {
  label: string;
  revealLabel: string;
  copyPathLabel: string;
  saveAsLabel: string;
  onReveal: () => void;
  onCopyPath: () => void;
  onSaveAs: () => void;
}

/**
 * Compact, keyboard-dismissable file action menu used by the preview header.
 * Common reading actions stay visible in the toolbar; filesystem actions live
 * here so the document title keeps enough room in narrow panel layouts.
 */
export default function PreviewActionsMenu({
  label,
  revealLabel,
  copyPathLabel,
  saveAsLabel,
  onReveal,
  onCopyPath,
  onSaveAs,
}: PreviewActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const run = (action: () => void) => {
    setOpen(false);
    action();
  };

  const itemClass = cn(
    'w-full flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-minor',
    'text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)] hover:text-[var(--abu-text-primary)]',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--abu-clay-ring)]',
  );

  return (
    <div ref={rootRef} className="relative">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)]',
          open && 'bg-[var(--abu-bg-hover)] text-[var(--abu-text-primary)]',
        )}
        title={label}
      >
        <MoreHorizontal className="size-3.5" strokeWidth={1.6} />
      </Button>

      {open && (
        <div
          role="menu"
          aria-label={label}
          className={cn(
            'absolute right-0 top-[calc(100%+6px)] z-50 w-52 rounded-xl p-1.5',
            'border border-[var(--abu-border)] bg-[var(--abu-bg-base)] shadow-[0_12px_32px_rgba(35,31,23,0.14)]',
            'animate-in fade-in-0 zoom-in-95 slide-in-from-top-1 duration-150',
          )}
        >
          <button role="menuitem" type="button" className={itemClass} onClick={() => run(onReveal)}>
            <FolderOpen className="size-3.5 text-[var(--abu-text-tertiary)]" strokeWidth={1.6} />
            {revealLabel}
          </button>
          <button role="menuitem" type="button" className={itemClass} onClick={() => run(onCopyPath)}>
            <Copy className="size-3.5 text-[var(--abu-text-tertiary)]" strokeWidth={1.6} />
            {copyPathLabel}
          </button>
          <div className="my-1 h-px bg-[var(--abu-border-subtle)]" />
          <button role="menuitem" type="button" className={itemClass} onClick={() => run(onSaveAs)}>
            <Save className="size-3.5 text-[var(--abu-text-tertiary)]" strokeWidth={1.6} />
            {saveAsLabel}
          </button>
        </div>
      )}
    </div>
  );
}
