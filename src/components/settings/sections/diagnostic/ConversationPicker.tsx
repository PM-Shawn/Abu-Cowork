import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useI18n, format } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { formatRelativeTime } from '@/utils/messageTime';
import { cn } from '@/lib/utils';

const DEFAULT_VISIBLE = 20;

interface Props {
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}

/**
 * Multi-select conversation attach list for the diagnostic feedback form.
 * Deliberately has NO "select all" affordance — attaching a conversation
 * embeds its full message content, so each inclusion should be a conscious
 * per-conversation choice (see conversationPickerPrivacyHint).
 */
export default function ConversationPicker({ selectedIds, onChange, disabled }: Props) {
  const { t } = useI18n();
  const conversationIndex = useChatStore((s) => s.conversationIndex);
  const activeConversationId = useChatStore((s) => s.activeConversationId);

  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState('');
  const [showAll, setShowAll] = useState(false);

  const sorted = useMemo(
    () => Object.values(conversationIndex).sort((a, b) => b.updatedAt - a.updatedAt),
    [conversationIndex],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((c) => (c.title || '').toLowerCase().includes(q));
  }, [sorted, search]);

  const isFiltering = search.trim().length > 0;
  const visible = isFiltering || showAll ? filtered : filtered.slice(0, DEFAULT_VISIBLE);
  const hasMore = !isFiltering && !showAll && filtered.length > DEFAULT_VISIBLE;

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const toggle = (id: string) => {
    if (disabled) return;
    onChange(selectedSet.has(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);
  };

  return (
    <section>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setExpanded((v) => !v)}
        className="w-full h-auto justify-start gap-2 px-0 py-1.5 text-[12px] text-[var(--abu-text-tertiary)] hover:bg-transparent hover:text-[var(--abu-text-primary)]"
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span>{t.diagnostic.conversationPickerTitle}</span>
        {selectedIds.length > 0 && (
          <span className="ml-auto text-[11px] text-[var(--abu-text-muted)]">
            {format(t.diagnostic.conversationPickerSelectedCount, { count: selectedIds.length })}
          </span>
        )}
      </Button>

      {expanded && (
        <div className="mb-2 pl-5 pr-1 py-2 bg-[var(--abu-bg-muted)] rounded-md">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t.diagnostic.conversationPickerSearchPlaceholder}
            disabled={disabled}
            className="h-7 text-[12px] mb-2"
          />

          {visible.length === 0 ? (
            <div className="py-3 text-center text-[11px] text-[var(--abu-text-muted)]">
              {t.diagnostic.conversationPickerEmpty}
            </div>
          ) : (
            <ul className="max-h-64 overflow-y-auto space-y-0.5">
              {visible.map((c) => (
                <li key={c.id}>
                  <label
                    className={cn(
                      'flex items-center gap-2 py-1 px-1.5 rounded-md hover:bg-[var(--abu-bg-hover)] cursor-pointer',
                      disabled && 'opacity-50 pointer-events-none',
                    )}
                  >
                    <Checkbox checked={selectedSet.has(c.id)} onChange={() => toggle(c.id)} disabled={disabled} />
                    <span className="flex-1 min-w-0 truncate text-[12px] text-[var(--abu-text-primary)]">
                      {c.title || t.diagnostic.conversationPickerNoTitle}
                    </span>
                    {c.id === activeConversationId && (
                      <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] bg-[var(--abu-clay)]/15 text-[var(--abu-clay)]">
                        {t.diagnostic.conversationPickerCurrentBadge}
                      </span>
                    )}
                    <span className="shrink-0 text-[11px] text-[var(--abu-text-muted)]">
                      {formatRelativeTime(c.updatedAt)}
                    </span>
                    <span className="shrink-0 text-[11px] text-[var(--abu-text-muted)] w-16 text-right">
                      {format(t.diagnostic.conversationPickerMessageCount, { count: c.messageCount })}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}

          {hasMore && (
            <Button
              type="button"
              variant="link"
              size="xs"
              className="mt-1 px-1.5 h-auto"
              onClick={() => setShowAll(true)}
              disabled={disabled}
            >
              {t.diagnostic.conversationPickerLoadMore}
            </Button>
          )}
        </div>
      )}

      <div className="pl-5 pb-1 text-[11px] text-[var(--abu-text-tertiary)] leading-relaxed">
        {t.diagnostic.conversationPickerPrivacyHint}
      </div>
    </section>
  );
}
