import { useCallback, useEffect, useRef, useState } from 'react';
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
 * standalone Radix dropdown package is not a dependency. Because it claims
 * `role="menu"` it also keeps that role's promises: focus enters the panel on
 * open, Escape/Tab close it and hand focus back to the trigger, and
 * ArrowDown/ArrowUp roam the items (wrapping). Clicks inside the panel never
 * reach an ancestor row, so the menu can sit on a clickable card.
 */
export default function InstalledItemMenu({ actions, ariaLabel, testId }: InstalledItemMenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const getItems = useCallback(
    () => Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []),
    [],
  );

  const closeAndRestoreFocus = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  // Focus enters the panel on open — the first item that can actually be chosen.
  useEffect(() => {
    if (!open) return;
    const items = getItems();
    const first = items.find((item) => item.getAttribute('aria-disabled') !== 'true') ?? items[0];
    first?.focus();
  }, [open, getItems]);

  useEffect(() => {
    if (!open) return;
    const handleClick = () => setOpen(false);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeAndRestoreFocus();
        return;
      }
      // Tabbing away must not leave an open menu behind; let the browser move on
      // from the trigger rather than from an item that is about to unmount.
      if (event.key === 'Tab') {
        closeAndRestoreFocus();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const items = getItems();
      if (items.length === 0) return;
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = current === -1
        ? (step === 1 ? 0 : items.length - 1)
        : (current + step + items.length) % items.length;
      items[next]?.focus();
    };
    document.addEventListener('click', handleClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('click', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, getItems, closeAndRestoreFocus]);

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
        tabIndex={-1}
        title={action.disabledReason}
        onClick={(event) => {
          // The menu may sit on a clickable row/card — the primitive owns the guard,
          // for disabled items too (their click is a no-op, not the row's).
          event.stopPropagation();
          if (disabled) return;
          // Restore focus to the trigger before onSelect: the focused item is about to
          // unmount, and an onSelect that moves focus itself (opening a dialog) still wins.
          closeAndRestoreFocus();
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
        ref={triggerRef}
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
          ref={panelRef}
          role="menu"
          aria-label={ariaLabel}
          onClick={(event) => event.stopPropagation()}
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
