import type { ComponentProps, ReactNode } from 'react';
import { Icon } from '@/components/ds/icon';
import { Pressable } from '@/components/ds/pressable';
import { cn } from '@/lib/utils';
import { windowDragRowProps } from '@/utils/windowDrag';

export interface TopTabNavItem<T extends string = string> {
  id: T;
  label: string;
  /** A design-system icon: callers pass `AppIcons.*`. */
  icon: ComponentProps<typeof Icon>['icon'];
  /** Optional trailing adornment (e.g. an update-count badge). Rendered after
   *  the label, inside the tab button, so it moves with the tab. */
  badge?: ReactNode;
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
 * Shared horizontal tab-nav (ToolboxModal / TeamView / AutomationView) with a
 * filled-pill active state (no underline, no bottom border line). The tabs stay
 * plain buttons: both E2E suites find them by that role.
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
      <div className="flex min-w-0 items-center gap-1">
        {items.map((item) => {
          const isActive = activeId === item.id;
          return (
            <Pressable
              key={item.id}
              onClick={() => onSelect(item.id)}
              className={cn(
                'flex h-7 shrink-0 items-center gap-2 rounded-control px-3 text-ui font-medium',
                // The selected fill is a step darker than the hover fill, so the tab
                // in view never reads like a tab the pointer happens to be over.
                isActive ? 'bg-fill-selected text-label' : 'text-label-secondary hover:bg-fill-hover hover:text-label',
              )}
            >
              <Icon icon={item.icon} size="md" />
              <span>{item.label}</span>
              {item.badge}
            </Pressable>
          );
        })}
      </div>
      {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
    </>
  );

  // belowChrome: content is centered in the same max-w-5xl container the card
  // grid uses, so the tabs' left edge and the actions' right edge line up with
  // the cards below.
  if (belowChrome) {
    return (
      <nav {...windowDragRowProps()} data-testid="top-tab-nav" className="shrink-0 px-8 pt-12 pb-3">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
          {content}
        </div>
      </nav>
    );
  }

  return (
    <nav
      {...windowDragRowProps()}
      data-testid="top-tab-nav"
      className={cn(
        'shrink-0 flex items-center justify-between gap-3 pt-3 pb-2 pr-4',
        sidebarCollapsed ? 'pl-[184px]' : 'pl-4'
      )}
    >
      {content}
    </nav>
  );
}
