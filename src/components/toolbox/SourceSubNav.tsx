import { cn } from '@/lib/utils';

/** The two SOURCES an Extensions tab can show — a marketplace catalog, or the
 *  user's own installed/authored items. This is NOT an install-state filter. */
export type ExtensionSource = 'market' | 'mine';

interface SourceSubNavProps {
  value: ExtensionSource;
  onChange: (value: ExtensionSource) => void;
  marketLabel: string;
  mineLabel: string;
  /** Prefix for the per-tab `data-testid` (`{prefix}-market` / `{prefix}-mine`). */
  testIdPrefix?: string;
  /** `id` of the element rendering the selected source, named by `aria-controls`
   *  so the pair reads as tabs over one panel rather than two loose buttons. */
  panelId?: string;
}

/**
 * 市场 | 我的 — the source sub-nav that sits under an Extensions tab's header.
 * A plain pill pair (same active treatment as {@link TopTabNav}) exposed as a
 * `tablist` so the active source is announced, not just coloured.
 */
export default function SourceSubNav({
  value, onChange, marketLabel, mineLabel, testIdPrefix = 'extensions-source', panelId,
}: SourceSubNavProps) {
  const items: { id: ExtensionSource; label: string }[] = [
    { id: 'market', label: marketLabel },
    { id: 'mine', label: mineLabel },
  ];
  return (
    <div
      role="tablist"
      aria-label={`${marketLabel} / ${mineLabel}`}
      className="flex items-center gap-1 pt-2 pb-1"
    >
      {items.map((item) => {
        const active = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={panelId}
            data-testid={`${testIdPrefix}-${item.id}`}
            onClick={() => onChange(item.id)}
            className={cn(
              'rounded-full px-3 py-1 text-body transition-colors',
              active
                ? 'bg-[var(--abu-bg-hover)] text-[var(--abu-text-primary)] font-medium'
                : 'text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)]',
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
