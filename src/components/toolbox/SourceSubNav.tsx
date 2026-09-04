import { cn } from '@/lib/utils';
import { DEFAULT_SOURCE_ID_PREFIX, sourceTabId, type ExtensionSource } from './extensionSource';

export type { ExtensionSource };

interface SourceSubNavProps {
  value: ExtensionSource;
  onChange: (value: ExtensionSource) => void;
  marketLabel: string;
  mineLabel: string;
  /** Prefix for each tab's `data-testid` AND its `id`
   *  (`{prefix}-market` / `{prefix}-mine` — see {@link sourceTabId}). */
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
  value, onChange, marketLabel, mineLabel, testIdPrefix = DEFAULT_SOURCE_ID_PREFIX, panelId,
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
            id={sourceTabId(item.id, testIdPrefix)}
            aria-selected={active}
            aria-controls={panelId}
            data-testid={sourceTabId(item.id, testIdPrefix)}
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
