import { Pressable } from '@/components/ds/pressable';
import { cn } from '@/lib/utils';
import { DEFAULT_SOURCE_ID_PREFIX, sourceTabId, type ExtensionSource } from './extensionSource';

// No `export type { ExtensionSource }` here on purpose: the type has exactly one
// home, `./extensionSource`, and a second import path is how half the callers
// end up naming a component module for a type it does not own.

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
          <Pressable
            key={item.id}
            role="tab"
            id={sourceTabId(item.id, testIdPrefix)}
            aria-selected={active}
            aria-controls={panelId}
            data-testid={sourceTabId(item.id, testIdPrefix)}
            onClick={() => onChange(item.id)}
            className={cn(
              'h-6 rounded-control px-3 text-ui',
              // The selected fill, the same pill TopTabNav's tab in view uses: the
              // two rows of one nav agree on what "selected" looks like, and it is
              // a step darker than the hover fill on the line below.
              active ? 'bg-fill-selected font-medium text-label' : 'text-label-secondary hover:bg-fill-hover hover:text-label',
            )}
          >
            {item.label}
          </Pressable>
        );
      })}
    </div>
  );
}
