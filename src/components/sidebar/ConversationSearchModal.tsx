import { useEffect, useMemo, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useI18n } from '@/i18n';
import { Search, MessageSquare } from 'lucide-react';

/**
 * Centered command-palette-style conversation search. Opened from the title-bar
 * search icon. Filters conversations by title and jumps to the picked one.
 */
export default function ConversationSearchModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const conversationIndex = useChatStore((s) => s.conversationIndex);
  const switchConversation = useChatStore((s) => s.switchConversation);
  const setViewMode = useSettingsStore((s) => s.setViewMode);
  const setFileTreeMode = usePreviewStore((s) => s.setFileTreeMode);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset + focus each time the modal opens.
  useEffect(() => {
    if (open) {
      setQuery('');
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(conversationIndex)
      .filter((c) => !q || c.title.toLowerCase().includes(q))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 50);
  }, [conversationIndex, query]);

  if (!open) return null;

  const pick = (id: string) => {
    switchConversation(id);
    setViewMode('chat');
    setFileTreeMode(false);
    onClose();
  };

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
              else if (e.key === 'Enter' && results.length > 0) pick(results[0].id);
            }}
            placeholder={t.sidebar.searchPlaceholder}
            className="flex-1 bg-transparent text-sm text-[var(--abu-text-primary)] placeholder:text-[var(--abu-text-muted)] focus:outline-none"
          />
        </div>

        {/* Results */}
        <div className="flex-1 min-h-0 overflow-y-auto overlay-scroll py-1">
          {results.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-[var(--abu-text-muted)]">
              {t.sidebar.noSearchResults}
            </div>
          ) : (
            results.map((c) => (
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
