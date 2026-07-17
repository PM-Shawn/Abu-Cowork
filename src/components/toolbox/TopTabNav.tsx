import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface TopTabNavItem<T extends string = string> {
  id: T;
  label: string;
  icon: LucideIcon;
}

interface TopTabNavProps<T extends string> {
  items: TopTabNavItem<T>[];
  activeId: T;
  onSelect: (id: T) => void;
  /** When the sidebar is collapsed, the window's floating controls (sidebar
   *  toggle / search / new-task) + macOS traffic lights float over the card's
   *  top-left — pad the row right to clear them. Only used in the default
   *  (non-`belowChrome`) layout; ignored when `belowChrome` is true. */
  sidebarCollapsed?: boolean;
  /** Content rendered on the far right of the row (e.g. search box + create button). */
  right?: ReactNode;
  /** When true, the row sits below the window's floating title-bar controls
   *  instead of flush at the card top (e.g. ToolboxModal's content-area header) —
   *  so it skips the `sidebarCollapsed` clearance hack and instead gets a bit of
   *  top breathing room so it doesn't look jammed against the card's top edge. */
  belowChrome?: boolean;
}

/**
 * Shared horizontal tab-nav (ToolboxModal / AutomationView) with a filled-pill
 * active state (no underline, no bottom border line).
 *
 * Two positioning modes:
 *  - default: sits flush at the card top — when the sidebar is collapsed the
 *    window's floating controls + macOS traffic lights sit over the card's
 *    top-left, so `sidebarCollapsed` pads the row right to clear them.
 *  - `belowChrome`: the row is placed below those floating controls instead
 *    (no horizontal clearance needed), with a small top margin instead.
 */
export default function TopTabNav<T extends string>({
  items, activeId, onSelect, sidebarCollapsed = false, right, belowChrome = false,
}: TopTabNavProps<T>) {
  const content = (
    <>
      <div className="flex items-center gap-1 min-w-0">
        {items.map((item) => {
          const Icon = item.icon;
          const isActive = activeId === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onSelect(item.id)}
              className={cn(
                'flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors shrink-0',
                isActive
                  ? 'bg-[var(--abu-bg-active)] text-[var(--abu-text-primary)]'
                  : 'text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)]'
              )}
            >
              <Icon className={cn(
                'h-4 w-4 shrink-0',
                isActive ? 'text-[var(--abu-clay)]' : 'text-[var(--abu-text-muted)]'
              )} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>
      {right && <div className="flex items-center gap-2 shrink-0">{right}</div>}
    </>
  );

  // belowChrome: content is centered in the same max-w-5xl container the card
  // grid uses, so the tabs' left edge and the actions' right edge line up with
  // the cards below.
  if (belowChrome) {
    return (
      <nav className="shrink-0 pt-12 pb-3 px-8">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-3">
          {content}
        </div>
      </nav>
    );
  }

  return (
    <nav
      className={cn(
        'shrink-0 flex items-center justify-between gap-3 pt-3 pb-2 pr-4',
        sidebarCollapsed ? 'pl-[184px]' : 'pl-4'
      )}
    >
      {content}
    </nav>
  );
}
