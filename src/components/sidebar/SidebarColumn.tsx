import type { ReactNode } from 'react';

/**
 * The sidebar's column in the app layout. Width changes are instant (no slide animation).
 * A collapsed column is 0px wide but its buttons still exist, so `inert` keeps them out of
 * the tab order and away from screen readers.
 */
export function SidebarColumn({ collapsed, children }: { collapsed: boolean; children: ReactNode }) {
  return (
    <div
      data-abu-sidebar-column
      inert={collapsed}
      className="flex shrink-0 flex-col overflow-hidden"
      style={{ width: collapsed ? 0 : 260 }}
    >
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
