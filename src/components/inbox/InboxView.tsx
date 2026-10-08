import { memo, useEffect, useMemo, useState } from 'react';
import { EmptyState } from '@/components/ds/empty-state';
import { AppIcons } from '@/components/ds/icons';
import { Pressable } from '@/components/ds/pressable';
import { ScrollArea } from '@/components/ds/scroll-area';
import { useRowFocus } from '@/components/common/useRowFocus';
import { useInboxStore } from '@/stores/inboxStore';
import { useTodosStore } from '@/stores/todosStore';
import { useI18n, format } from '@/i18n';
import { cn } from '@/lib/utils';
import { windowDragRowProps } from '@/utils/windowDrag';
import InboxItemRow from './InboxItem';

type Tab = 'pending' | 'all';

/**
 * The inbox page. `App` renders for every piece of a streamed reply, so the page takes no props
 * and reads one store field at a time.
 */
const InboxView = memo(function InboxView() {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('pending');

  const itemsRecord = useInboxStore((s) => s.items);
  const markAllRead = useInboxStore((s) => s.markAllRead);
  const accept = useInboxStore((s) => s.accept);
  const ignore = useInboxStore((s) => s.ignore);
  const markRead = useInboxStore((s) => s.markRead);
  const createTodo = useTodosStore((s) => s.createTodo);
  // An answered item leaves the pending tab, or stays under All without its buttons.
  const focus = useRowFocus('data-inbox-item');

  // Sort all items by createdAt desc; tab filters status === 'pending' when needed.
  // Subscribing to the raw record (stable identity) + useMemo prevents the
  // "Maximum update depth exceeded" loop that selectors returning new arrays cause.
  const items = useMemo(
    () => Object.values(itemsRecord).sort((a, b) => b.createdAt - a.createdAt),
    [itemsRecord],
  );
  const pendingItems = useMemo(
    () => items.filter((i) => i.status === 'pending'),
    [items],
  );
  const list = tab === 'pending' ? pendingItems : items;

  // Visiting the inbox clears the unread badge in the sidebar.
  useEffect(() => {
    markAllRead();
  }, [markAllRead]);

  const handleAccept = (id: string) => {
    focus.note(id);
    const item = useInboxStore.getState().items[id];
    if (!item || item.type !== 'agent_proposed_todo') {
      accept(id);
      return;
    }
    const draft = (item.payload?.draft ?? {}) as { title?: string };
    if (draft.title) {
      createTodo({
        title: draft.title,
        source: 'agent_proposed',
        assignee: 'human',
        sourceConversationId: item.conversationId,
      });
    }
    accept(id);
  };

  const handleIgnore = (id: string) => {
    focus.note(id);
    ignore(id);
  };

  return (
    <div className="flex h-full flex-col bg-surface">
      <div {...windowDragRowProps()} className="flex items-center justify-between border-b border-separator px-6 py-4">
        <h1 className="text-title text-label">{t.inbox.title}</h1>
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            {(['pending', 'all'] as Tab[]).map((k) => (
              <Pressable
                key={k}
                ref={tab === k ? focus.fallback : undefined}
                aria-pressed={tab === k}
                onClick={() => setTab(k)}
                className={cn(
                  'h-7 rounded-control px-3 text-ui',
                  tab === k ? 'bg-fill-selected text-label' : 'text-label-secondary hover:bg-fill-hover',
                )}
              >
                {k === 'pending' ? t.inboxTabs.pending : t.inboxTabs.all}
              </Pressable>
            ))}
          </div>
          {pendingItems.length > 0 && (
            <span className="text-ui-sm text-label-tertiary">
              {format(t.inbox.pendingCount, { count: pendingItems.length })}
            </span>
          )}
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div ref={focus.root} className="space-y-2 px-6 py-4">
          {list.length === 0 ? (
            <EmptyState icon={AppIcons.inbox} title={t.inbox.empty} />
          ) : (
            list.map((item) => (
              <InboxItemRow
                key={item.id}
                item={item}
                onAccept={() => handleAccept(item.id)}
                onIgnore={() => handleIgnore(item.id)}
                onView={() => markRead(item.id)}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
});

export default InboxView;
