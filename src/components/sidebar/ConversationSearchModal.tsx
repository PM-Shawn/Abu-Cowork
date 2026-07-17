import { useEffect, useMemo, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useI18n } from '@/i18n';
import { Search, MessageSquare } from 'lucide-react';
import { catalogSearch, type SearchHit } from '@/core/session/conversationStorage';
import { renderMarkedText, highlightQuery } from '@/utils/searchHighlight';

const HL = 'bg-[var(--abu-clay-bg-15)] text-[var(--abu-clay)] rounded-sm';

/**
 * Centered command-palette-style conversation search. Opened from the title-bar
 * search icon. With an empty query it lists recent conversations; typing runs a
 * full-text search (FTS5 over title + message body via `catalogSearch`) and
 * shows title + a body-hit snippet. Picking a result jumps to that conversation.
 */
export default function ConversationSearchModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const conversationIndex = useChatStore((s) => s.conversationIndex);
  const switchConversation = useChatStore((s) => s.switchConversation);
  const setViewMode = useSettingsStore((s) => s.setViewMode);
  const setFileTreeMode = usePreviewStore((s) => s.setFileTreeMode);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  // Race guard: a stale in-flight request (from a previous keystroke) must not
  // overwrite the latest results once both resolve out of order.
  const tokenRef = useRef(0);

  const trimmed = query.trim();
  const isSearching = trimmed.length > 0;

  // Reset + focus each time the modal opens.
  useEffect(() => {
    if (open) {
      setQuery('');
      setHits([]);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Debounced full-text search. Empty query clears hits (recents are shown).
  useEffect(() => {
    if (!isSearching) {
      tokenRef.current++;
      setHits([]);
      return;
    }
    const token = ++tokenRef.current;
    const timer = setTimeout(() => {
      catalogSearch(trimmed).then((res) => {
        if (tokenRef.current === token) setHits(res);
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [trimmed, isSearching]);

  // Recent conversations shown when the query is empty.
  const recents = useMemo(
    () =>
      Object.values(conversationIndex)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 50),
    [conversationIndex]
  );

  if (!open) return null;

  const pick = (id: string) => {
    switchConversation(id);
    setViewMode('chat');
    setFileTreeMode(false);
    onClose();
  };

  const firstId = isSearching ? hits[0]?.conv_id : recents[0]?.id;
  const isEmpty = isSearching ? hits.length === 0 : recents.length === 0;

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/20 flex items-start justify-center"
      onMouseDown={onClose}
    >
      <div
        className="mt-[14vh] w-[560px] max-w-[90vw] max-h-[60vh] flex flex-col rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-base)] shadow-[0_12px_40px_-4px_rgba(0,0,0,0.18)] overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="shrink-0 flex items-center gap-2 px-4 h-12 border-b border-[var(--abu-border)]">
          <Search className="h-4 w-4 shrink-0 text-[var(--abu-text-muted)]" strokeWidth={1.5} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              else if (e.key === 'Enter' && firstId) pick(firstId);
            }}
            placeholder={t.sidebar.searchPlaceholder}
            className="flex-1 bg-transparent text-sm text-[var(--abu-text-primary)] placeholder:text-[var(--abu-text-muted)] focus:outline-none"
          />
        </div>

        {/* Results */}
        <div className="flex-1 min-h-0 overflow-y-auto overlay-scroll py-1">
          {isEmpty ? (
            <div className="px-4 py-8 text-center text-sm text-[var(--abu-text-muted)]">
              {t.sidebar.noSearchResults}
            </div>
          ) : isSearching ? (
            hits.map((h) => (
              <button
                key={h.conv_id}
                onClick={() => pick(h.conv_id)}
                className="flex flex-col items-start gap-0.5 w-full px-4 py-2 text-left hover:bg-[var(--abu-bg-hover)]"
              >
                <div className="flex items-center gap-2.5 w-full min-w-0">
                  <MessageSquare className="h-4 w-4 shrink-0 text-[var(--abu-text-tertiary)]" strokeWidth={1.5} />
                  <span className="flex-1 min-w-0 truncate text-sm text-[var(--abu-text-primary)]">
                    {highlightQuery(h.title, trimmed, HL)}
                  </span>
                </div>
                {h.snippet && (
                  <span className="w-full pl-[26px] truncate text-xs text-[var(--abu-text-muted)]">
                    {renderMarkedText(h.snippet, HL)}
                  </span>
                )}
              </button>
            ))
          ) : (
            recents.map((c) => (
              <button
                key={c.id}
                onClick={() => pick(c.id)}
                className="flex items-center gap-2.5 w-full px-4 py-2 text-left hover:bg-[var(--abu-bg-hover)]"
              >
                <MessageSquare className="h-4 w-4 shrink-0 text-[var(--abu-text-tertiary)]" strokeWidth={1.5} />
                <span className="flex-1 min-w-0 truncate text-sm text-[var(--abu-text-primary)]">{c.title}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
