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
  description?: ReactNode;
  /** Rendered node so callers can pass an emoji, <img>, or a status-colored icon. */
  avatar?: ReactNode;
  nameTestId?: string;
  /** Extra disclosure content stays outside the truncated description. */
  footer?: ReactNode;
  /** Optional top-right corner adornment (source badge, connection status dot, …). */
  badge?: ReactNode;
  /** Optional test hook — the card IS the click target, so a wrapper testid
   *  around it would not receive the card's click. */
  testId?: string;
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
export default function ToolCard({ item, onClick }: { item: ToolItem; onClick?: () => void }) {
  const interactive = onClick !== undefined;

  return (
    // Interactive cards use <div role="button"> rather than a real <button>
    // so nested controls remain valid HTML. Display-only catalog cards omit
    // the role and tab stop while keeping the same visual structure.
    <div
      onClick={onClick}
      data-testid={item.testId}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={(e) => {
        if (!onClick) return;
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
        'group flex flex-col gap-2 w-full overflow-hidden rounded-xl p-4 text-left',
        item.footer ? 'min-h-[120px] h-full' : 'h-[120px]',
        'bg-[var(--abu-bg-subtle)] border border-[var(--abu-border)]',
        interactive && 'cursor-pointer hover:border-[var(--abu-clay)] hover:shadow-sm',
        !interactive && 'cursor-default',
        'transition-all duration-150'
      )}
    >
      {/* Row 1: avatar + name (centered so they align), optional badge + toggle.
          The row has a WIDTH PRIORITY, because a grid column is only ~240px
          wide and a caller can legitimately fill it: the action (`toggle`) is
          never squeezed, the name keeps a floor so it truncates rather than
          disappearing, and the badge — the one purely decorative slot — is what
          yields. A badge that carries several chips should let them wrap
          (`flex-wrap`) so narrowing its box costs a line, not a chip.

          It used to be the other way round: the name was the ONLY flexible item
          (`flex-1 min-w-0`, i.e. flex-basis 0) between two `shrink-0` groups,
          so a card whose badge + action added up to the row's full width
          rendered its title at exactly 0px — gone from the screen, and reported
          `hidden` by Playwright. That is what the organization plugin catalog
          hit once its console stopped advertising a signing key and every row
          grew a second 未签名 chip. */}
      <div className="flex items-center gap-3 w-full shrink-0">
        <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-[var(--abu-bg-active)] text-h-md select-none shrink-0 overflow-hidden">
          {item.avatar ?? '🤖'}
        </div>
        <p
          className="flex-1 min-w-10 text-body font-semibold leading-snug truncate text-[var(--abu-text-primary)]"
          title={item.name}
          data-testid={item.nameTestId}
        >
          {item.name}
        </p>
        {item.badge && <div className="min-w-0 shrink overflow-hidden">{item.badge}</div>}
        {item.toggle && <div className="shrink-0">{item.toggle}</div>}
      </div>

      {/* Row 2: description — up to two lines. break-words so long unbreakable
          strings (e.g. URLs) wrap instead of overflowing. */}
      <p className="w-full text-minor text-[var(--abu-text-secondary)] leading-relaxed line-clamp-2 break-words">
        {item.description}
      </p>
      {item.footer && <div className="mt-auto text-caption text-[var(--abu-text-muted)]">{item.footer}</div>}
    </div>
  );
}
