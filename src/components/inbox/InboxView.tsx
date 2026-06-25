import { useEffect, useMemo, useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useInboxStore } from '@/stores/inboxStore';
import { useTodosStore } from '@/stores/todosStore';
import { useI18n, format } from '@/i18n';
import { cn } from '@/lib/utils';
import InboxItemRow from './InboxItem';

type Tab = 'pending' | 'all';

export default function InboxView() {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('pending');

  const itemsRecord = useInboxStore((s) => s.items);
  const markAllRead = useInboxStore((s) => s.markAllRead);
  const accept = useInboxStore((s) => s.accept);
  const ignore = useInboxStore((s) => s.ignore);
  const markRead = useInboxStore((s) => s.markRead);
  const createTodo = useTodosStore((s) => s.createTodo);

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

  return (
    <div className="flex flex-col h-full bg-[var(--abu-bg-base)]">
      <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--abu-border)]">
        <h1 className="text-[18px] font-semibold text-[var(--abu-text-primary)]">{t.inbox.title}</h1>
        <div className="flex items-center gap-2">
          <div className="flex gap-1 text-[13px]">
            {(['pending', 'all'] as Tab[]).map((k) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={cn(
                  'px-3 py-1.5 rounded-md',
                  tab === k
                    ? 'bg-[var(--abu-bg-active)] text-[var(--abu-text-primary)]'
                    : 'text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)]',
                )}
              >
                {k === 'pending' ? t.inboxTabs.pending : t.inboxTabs.all}
              </button>
            ))}
          </div>
          {pendingItems.length > 0 && (
            <span className="text-[13px] text-[var(--abu-text-muted)]">
              {format(t.inbox.pendingCount, { count: pendingItems.length })}
            </span>
          )}
        </div>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="px-6 py-4 space-y-2">
          {list.length === 0 ? (
            <div className="px-6 py-16 text-center text-[var(--abu-text-muted)] text-[14px]">
              {t.inbox.empty}
            </div>
          ) : (
            list.map((item) => (
              <InboxItemRow
                key={item.id}
                item={item}
                onAccept={() => handleAccept(item.id)}
                onIgnore={() => ignore(item.id)}
                onView={() => markRead(item.id)}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
