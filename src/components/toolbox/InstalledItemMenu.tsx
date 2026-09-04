import { useEffect, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface InstalledItemMenuAction {
  id: 'trial' | 'manage' | 'uninstall' | 'edit' | 'view' | 'delete' | 'remove';
  label: string;
  onSelect: () => void;
  /** Renders in the destructive group (after the separator), in danger colour. */
  destructive?: boolean;
  /** When set the item renders disabled with this text as its title/aria-description. */
  disabledReason?: string;
}

interface InstalledItemMenuProps {
  actions: InstalledItemMenuAction[];
  /** Accessible name of the `···` trigger, e.g. "canva 的操作". */
  ariaLabel: string;
  /** `data-testid` of the trigger; each item gets `{testId}-{action.id}`. */
  testId: string;
}

/**
 * The `···` menu on an installed/configured extension item. Destructive actions
 * are grouped after a separator; an action carrying `disabledReason` renders
 * disabled with that reason as its tooltip and never fires.
 *
 * Hand-rolled on the same primitive as {@link ToolboxCreateMenu} (absolute panel +
 * document outside-click close) — the repo has no `ui/dropdown-menu`, and the
 * standalone Radix dropdown package is not a dependency.
 */
export default function InstalledItemMenu({ actions, ariaLabel, testId }: InstalledItemMenuProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handleClick = () => setOpen(false);
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [open]);

  const primary = actions.filter((a) => !a.destructive);
  const destructive = actions.filter((a) => a.destructive);

  const renderItem = (action: InstalledItemMenuAction) => {
    const disabled = Boolean(action.disabledReason);
    return (
      <button
        key={action.id}
        type="button"
        role="menuitem"
        data-testid={`${testId}-${action.id}`}
        aria-disabled={disabled ? 'true' : undefined}
        title={action.disabledReason}
        onClick={() => {
          if (disabled) return;
          setOpen(false);
          action.onSelect();
        }}
        className={cn(
          'w-full flex items-center px-3 py-1.5 text-minor text-left transition-colors',
          disabled
            ? 'text-[var(--abu-text-muted)] cursor-not-allowed'
            : cn(
              'hover:bg-[var(--abu-bg-active)]',
              action.destructive ? 'text-[var(--abu-danger)]' : 'text-[var(--abu-text-primary)]',
            ),
        )}
      >
        {action.label}
      </button>
    );
  };

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={testId}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className="flex items-center justify-center h-7 w-7 rounded-lg text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-active)] transition-colors"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={ariaLabel}
          className="absolute z-50 top-full right-0 mt-1 w-44 bg-[var(--abu-bg-base)] rounded-lg shadow-lg border border-[var(--abu-border)] py-1"
        >
          {primary.map(renderItem)}
          {primary.length > 0 && destructive.length > 0 && (
            <div role="separator" className="my-1 h-px bg-[var(--abu-border)]" />
          )}
          {destructive.map(renderItem)}
        </div>
      )}
    </div>
  );
}
