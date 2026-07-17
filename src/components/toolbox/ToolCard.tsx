import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Display-layer item for the toolbox card grid. Each tab (agents / skills / MCP)
 * maps its own domain object into this shape; the card is purely presentational
 * and never touches business state. `raw` is intentionally omitted — the owning
 * section keeps the source object and resolves it back on click via `id`.
 */
export interface ToolItem {
  id: string;
  name: string;
  description?: string;
  /** Rendered node so callers can pass an emoji, <img>, or a status-colored icon. */
  avatar?: ReactNode;
  /** Optional top-right corner adornment (source badge, connection status dot, …). */
  badge?: ReactNode;
  /** Optional top-right interactive control (e.g. an enable/disable switch).
   *  Rendered after `badge`; its own click must stopPropagation so toggling
   *  doesn't also open the card's detail view. */
  toggle?: ReactNode;
}

/**
 * Short landscape card (WorkBuddy-style): (1) avatar + name on one row (vertically
 * centered so they line up) + an optional top-right badge, (2) the description
 * clamped to two lines. No tag row — it made cards look lopsided and too tall.
 * Height is FIXED (`h-[120px]`) and the description always reserves two lines, so
 * every card is the same height whether its description is one line or two (grid
 * `stretch` only equalizes within a row, not across rows — hence a fixed height).
 */
export default function ToolCard({ item, onClick }: { item: ToolItem; onClick: () => void }) {
  return (
    // A <div role="button"> rather than a real <button> so an interactive
    // <Toggle> button can nest inside (button-in-button is invalid HTML).
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        // Only when the card itself is focused — not a nested control (the enable
        // Toggle). A Space/Enter keydown on the Toggle bubbles here; without this
        // guard it would also open the detail modal on top of the toggle action.
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        'group flex flex-col gap-2 w-full h-[120px] overflow-hidden rounded-xl p-4 text-left cursor-pointer',
        'bg-[var(--abu-bg-subtle)] border border-[var(--abu-border)]',
        'hover:border-[var(--abu-clay)] hover:shadow-sm transition-all duration-150'
      )}
    >
      {/* Row 1: avatar + name (centered so they align), optional badge + toggle */}
      <div className="flex items-center gap-3 w-full shrink-0">
        <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-[var(--abu-bg-active)] text-xl select-none shrink-0 overflow-hidden">
          {item.avatar ?? '🤖'}
        </div>
        <p
          className="flex-1 min-w-0 text-sm font-semibold leading-snug truncate text-[var(--abu-text-primary)]"
          title={item.name}
        >
          {item.name}
        </p>
        {item.badge && <div className="shrink-0">{item.badge}</div>}
        {item.toggle && <div className="shrink-0">{item.toggle}</div>}
      </div>

      {/* Row 2: description — up to two lines. break-words so long unbreakable
          strings (e.g. URLs) wrap instead of overflowing. */}
      <p className="w-full text-[12px] text-[var(--abu-text-secondary)] leading-relaxed line-clamp-2 break-words">
        {item.description}
      </p>
    </div>
  );
}
