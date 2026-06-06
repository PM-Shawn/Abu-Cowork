import { useEffect, useMemo } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useInboxStore } from '@/stores/inboxStore';
import { useTodosStore } from '@/stores/todosStore';
import { useI18n, format } from '@/i18n';
import InboxItemRow from './InboxItem';

export default function InboxView() {
  const { t } = useI18n();
  // Subscribe to the raw record then derive the sorted list with useMemo.
  // A selector that returns `Object.values(...).sort()` creates a new array on every
  // render, which Zustand's default `===` equality treats as a change → infinite loop.
  const itemsRecord = useInboxStore((s) => s.items);
  const items = useMemo(
    () => Object.values(itemsRecord).sort((a, b) => b.createdAt - a.createdAt),
    [itemsRecord]
  );
  const markAllRead = useInboxStore((s) => s.markAllRead);
  const dismiss = useInboxStore((s) => s.dismiss);
  const markRead = useInboxStore((s) => s.markRead);
  const createTodo = useTodosStore((s) => s.createTodo);

  // 进入收件箱即视为已读，下次回来不再亮红点
  useEffect(() => {
    markAllRead();
  }, [markAllRead]);

  const unread = items.filter((i) => i.unread).length;

  const handleAccept = (id: string) => {
    const item = useInboxStore.getState().items[id];
    if (!item || item.type !== 'agent_proposed_todo') return;
    const draft = (item.payload?.draft ?? {}) as { title?: string };
    if (draft.title) {
      createTodo({
        title: draft.title,
        source: 'agent_proposed',
        assignee: 'human',
        sourceConversationId: item.conversationId,
      });
    }
    dismiss(id);
  };

  return (
    <div className="flex flex-col h-full bg-[var(--abu-bg-base)]">
      <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--abu-border)]">
        <h1 className="text-[18px] font-semibold text-[var(--abu-text-primary)]">{t.inbox.title}</h1>
        {items.length > 0 && (
          <span className="text-[13px] text-[var(--abu-text-muted)]">
            {format(t.inbox.pendingCount, { count: unread || items.length })}
          </span>
        )}
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="px-6 py-4 space-y-2">
          {items.length === 0 ? (
            <div className="px-6 py-16 text-center text-[var(--abu-text-muted)] text-[14px]">
              {t.inbox.empty}
            </div>
          ) : (
            items.map((item) => (
              <InboxItemRow
                key={item.id}
                item={item}
                onAccept={() => handleAccept(item.id)}
                onIgnore={() => dismiss(item.id)}
                onView={() => markRead(item.id)}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
