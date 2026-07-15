import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useI18n, format } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { formatRelativeTime } from '@/utils/messageTime';
import { MAX_ATTACH_CONVERSATIONS } from '@/core/diagnostic/collect';
import { cn } from '@/lib/utils';

interface Props {
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}

/**
 * Collapsed multi-select dropdown for attaching conversations to the diagnostic
 * feedback bundle. Trigger shows a summary ("已选 N 个" / placeholder); opening
 * reveals a search box + scrollable checkbox list. Deliberately has NO "select
 * all": each inclusion embeds a conversation's full messages, so it stays a
 * conscious per-conversation choice. Selecting a row keeps the dropdown open
 * (multi-select), unlike a single-select which closes on pick.
 */
export default function ConversationPicker({ selectedIds, onChange, disabled }: Props) {
  const { t } = useI18n();
  const conversationIndex = useChatStore((s) => s.conversationIndex);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const addToast = useToastStore((s) => s.addToast);

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside-click / Escape while open. Capture phase mirrors ui/Select
  // so an ancestor that stopPropagation()s on mousedown can't kill it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const sorted = useMemo(
    () => Object.values(conversationIndex).sort((a, b) => b.updatedAt - a.updatedAt),
    [conversationIndex],
  );
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((c) => (c.title || '').toLowerCase().includes(q));
  }, [sorted, search]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const toggle = (id: string) => {
    if (disabled) return;
    if (selectedSet.has(id)) {
      onChange(selectedIds.filter((x) => x !== id));
      return;
    }
    if (selectedIds.length >= MAX_ATTACH_CONVERSATIONS) {
      addToast({
        title: format(t.diagnostic.conversationPickerTooMany, { max: MAX_ATTACH_CONVERSATIONS }),
        type: 'warning',
        duration: 3000,
      });
      return;
    }
    onChange([...selectedIds, id]);
  };

  const isEmpty = selectedIds.length === 0;

  return (
    <div ref={containerRef} className="relative">
      {/* Trigger — looks like a select field, shows a selection summary. */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'w-full h-9 px-3 flex items-center justify-between rounded-lg border text-sm transition-all',
          'bg-[var(--abu-bg-muted)] border-[var(--abu-border)]',
          'focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)]',
          open && 'ring-2 ring-[var(--abu-clay-ring)] border-[var(--abu-clay)]',
          disabled && 'opacity-50 cursor-not-allowed',
        )}
      >
        <span
          className={cn(
            'truncate',
            isEmpty ? 'text-[var(--abu-text-placeholder)]' : 'text-[var(--abu-text-primary)]',
          )}
        >
          {isEmpty
            ? t.diagnostic.conversationPickerTriggerPlaceholder
            : format(t.diagnostic.conversationPickerSelectedCount, { count: selectedIds.length })}
        </span>
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 text-[var(--abu-text-muted)] transition-transform shrink-0 ml-2',
            open && 'rotate-180',
          )}
        />
      </button>

      {/* Dropdown — search + scrollable checkbox list. */}
      {open && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1 p-2 bg-[var(--abu-bg-base)] border border-[var(--abu-border)] rounded-xl shadow-lg">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t.diagnostic.conversationPickerSearchPlaceholder}
            disabled={disabled}
            autoFocus
            className="h-8 text-[12px] mb-2"
          />

          {filtered.length === 0 ? (
            <div className="py-3 text-center text-[11px] text-[var(--abu-text-muted)]">
              {t.diagnostic.conversationPickerEmpty}
            </div>
          ) : (
            <ul className="max-h-60 overflow-y-auto space-y-0.5 pr-1">
              {filtered.map((c) => (
                <li key={c.id}>
                  {/* Plain div + onClick, NOT a <label>: a <label> wrapping the
                      Checkbox <button> re-dispatches its click back to the
                      button in macOS WKWebView, double-toggling so the box could
                      never be unchecked. A single handler here = one toggle.
                      Keyboard access is via the inner Checkbox <button> (its own
                      tab stop) — the row div is intentionally NOT focusable, so
                      it can't double-fire a keydown alongside the button. */}
                  <div
                    onClick={() => toggle(c.id)}
                    className={cn(
                      'flex items-center gap-2 py-1 px-1.5 rounded-md hover:bg-[var(--abu-bg-hover)] cursor-pointer select-none',
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
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
