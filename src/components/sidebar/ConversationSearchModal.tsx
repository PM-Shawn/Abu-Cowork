import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useNoticeBadgeStore } from '@/stores/noticeBadgeStore';
import { useI18n } from '@/i18n';
import { Dialog } from '@/components/ds/dialog';
import { EmptyState } from '@/components/ds/empty-state';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { NavItem } from '@/components/ds/nav-item';
import { TextField } from '@/components/ds/text-field';
import { catalogSearch, type SearchHit, type ConversationMeta } from '@/core/session/conversationStorage';
import { renderMarkedText, highlightQuery } from '@/utils/searchHighlight';

const HL = 'rounded-control bg-fill-selected font-semibold text-label';

// Strip the `[Attachment: `name`]` prefix from a title for display (mirrors the
// sidebar's row rendering), falling back to the raw title if stripping empties it.
const ATTACH_RE = /\[Attachment:\s*`[^`]*`\]\s*/g;
const cleanTitle = (title: string): string => title.replace(ATTACH_RE, '').trim() || title;

// Only flat conversations belong in the palette — scheduled/trigger/team/project
// conversations live in their own sections and are hidden from the sidebar
// recents, so the search must not surface them either.
const isFlat = (c: ConversationMeta): boolean => !c.scheduledTaskId && !c.triggerId && !c.projectId;

/**
 * Command-palette-style conversation search. Opened from the title-bar search
 * icon. Empty query lists recent conversations; typing shows instant in-memory
 * title matches PLUS FTS5 body-content hits (via `catalogSearch`), so an existing
 * conversation is always findable by title even if the catalog is cold/unindexed.
 * Enter opens the first result, the arrow keys move between the field and the
 * results, and picking a result jumps to that conversation.
 */
export default function ConversationSearchModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const conversationIndex = useChatStore((s) => s.conversationIndex);
  const switchConversation = useChatStore((s) => s.switchConversation);
  const clearCompletedStatus = useChatStore((s) => s.clearCompletedStatus);
  const setViewMode = useSettingsStore((s) => s.setViewMode);
  const setFileTreeMode = usePreviewStore((s) => s.setFileTreeMode);
  const clearBadge = useNoticeBadgeStore((s) => s.clear);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Race guard: a stale in-flight request (from a previous keystroke) must not
  // overwrite the latest results once both resolve out of order.
  const tokenRef = useRef(0);

  const trimmed = query.trim();
  const isSearching = trimmed.length > 0;

  // Start empty each time the dialog opens; the dialog focuses the field itself.
  useEffect(() => {
    if (open) {
      setQuery('');
      setHits([]);
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
        .filter(isFlat)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 50),
    [conversationIndex]
  );

  // Instant in-memory title matches — reliable regardless of catalog state.
  const titleMatches = useMemo(() => {
    if (!isSearching) return [];
    const q = trimmed.toLowerCase();
    return Object.values(conversationIndex)
      .filter(isFlat)
      .filter((c) => cleanTitle(c.title).toLowerCase().includes(q))
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [conversationIndex, trimmed, isSearching]);

  // FTS body-content hits, scoped to flat conversations and deduped against the
  // instant title matches (title matches render first, richer body hits after).
  const bodyHits = useMemo(() => {
    if (!isSearching) return [];
    const titleIds = new Set(titleMatches.map((c) => c.id));
    return hits.filter((h) => {
      const meta = conversationIndex[h.conv_id];
      return !!meta && isFlat(meta) && !titleIds.has(h.conv_id);
    });
  }, [hits, titleMatches, conversationIndex, isSearching]);

  const pick = (id: string, jumpQuery?: string) => {
    switchConversation(id);
    setViewMode('chat');
    setFileTreeMode(false);
    clearBadge(id);
    clearCompletedStatus(id);
    // Body-content hits carry the query so ChatView can scroll to + highlight
    // the matching message. Title/recents picks pass nothing (no in-body target).
    if (jumpQuery) {
      useChatStore.getState().setPendingSearchJump({ convId: id, query: jumpQuery });
    }
    onClose();
  };

  // ArrowDown / ArrowUp step through the field and the results in order.
  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const results = listRef.current ? [...listRef.current.querySelectorAll<HTMLButtonElement>('button')] : [];
    const stops: HTMLElement[] = inputRef.current ? [inputRef.current, ...results] : results;
    const at = stops.indexOf(document.activeElement as HTMLElement);
    if (at === -1) return;
    const next = event.key === 'ArrowDown' ? Math.min(at + 1, stops.length - 1) : Math.max(at - 1, 0);
    event.preventDefault();
    stops[next].focus();
  };

  const firstId = isSearching ? (titleMatches[0]?.id ?? bodyHits[0]?.conv_id) : recents[0]?.id;
  const isEmpty = isSearching ? titleMatches.length === 0 && bodyHits.length === 0 : recents.length === 0;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title={t.common.search} titleHidden size="lg">
      <div onKeyDown={moveFocus}>
        <div className="flex items-center gap-2">
          <Icon icon={AppIcons.search} className="text-label-tertiary" />
          <TextField
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && firstId) pick(firstId);
            }}
            placeholder={t.sidebar.searchPlaceholder}
            className="min-w-0 flex-1"
          />
        </div>

        {/* Results */}
        <div ref={listRef} className="mt-3 h-80 space-y-1 overflow-y-auto">
          {isEmpty ? (
            <EmptyState icon={AppIcons.search} title={t.sidebar.noSearchResults} />
          ) : isSearching ? (
            <>
              {/* Instant title matches */}
              {titleMatches.map((c) => (
                <NavItem
                  key={c.id}
                  icon={AppIcons.conversation}
                  label={highlightQuery(cleanTitle(c.title), trimmed, HL)}
                  onClick={() => pick(c.id)}
                />
              ))}
              {/* FTS body-content hits: the title, and the matching passage under it */}
              {bodyHits.map((h) => (
                <div key={h.conv_id}>
                  <NavItem
                    icon={AppIcons.conversation}
                    label={highlightQuery(cleanTitle(h.title), trimmed, HL)}
                    aria-describedby={h.snippet ? `search-snippet-${h.conv_id}` : undefined}
                    onClick={() => pick(h.conv_id, trimmed)}
                  />
                  {h.snippet && (
                    <div
                      id={`search-snippet-${h.conv_id}`}
                      onClick={() => pick(h.conv_id, trimmed)}
                      className="cursor-pointer truncate pl-8 pr-2 text-ui-sm text-label-tertiary"
                    >
                      {renderMarkedText(h.snippet, HL)}
                    </div>
                  )}
                </div>
              ))}
            </>
          ) : (
            recents.map((c) => (
              <NavItem
                key={c.id}
                icon={AppIcons.conversation}
                label={cleanTitle(c.title)}
                onClick={() => pick(c.id)}
              />
            ))
          )}
        </div>
      </div>
    </Dialog>
  );
}
