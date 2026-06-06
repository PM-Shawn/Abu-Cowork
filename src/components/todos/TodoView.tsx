import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTodosStore } from '@/stores/todosStore';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import TodoItem from './TodoItem';

type Tab = 'today' | 'all';

function isSameDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear()
    && da.getMonth() === db.getMonth()
    && da.getDate() === db.getDate();
}

export default function TodoView() {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('today');
  const [draft, setDraft] = useState('');
  // Subscribe to the raw record (stable identity unless the record actually changes),
  // then derive lists with useMemo. Selectors that return new arrays each call
  // (.filter().sort()) would cause "Maximum update depth exceeded" because Zustand's
  // default `===` equality flags every render as a state change.
  const todos = useTodosStore((s) => s.todos);
  const createTodo = useTodosStore((s) => s.createTodo);
  const toggleStatus = useTodosStore((s) => s.toggleStatus);
  const deleteTodo = useTodosStore((s) => s.deleteTodo);

  const openTodos = useMemo(
    () => Object.values(todos)
      .filter((tt) => tt.status === 'todo' || tt.status === 'in_progress')
      .sort((a, b) => b.createdAt - a.createdAt),
    [todos]
  );
  const todayDone = useMemo(() => {
    const now = Date.now();
    return Object.values(todos)
      .filter((tt) => tt.status === 'done' && tt.completedAt && isSameDay(tt.completedAt, now))
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
  }, [todos]);

  const list = tab === 'today'
    ? [...openTodos, ...todayDone]
    : openTodos;

  const handleAdd = () => {
    const title = draft.trim();
    if (!title) return;
    createTodo({ title, source: 'manual' });
    setDraft('');
  };

  return (
    <div className="flex flex-col h-full bg-[var(--abu-bg-base)]">
      <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--abu-border)]">
        <h1 className="text-[18px] font-semibold text-[var(--abu-text-primary)]">{t.todos.title}</h1>
        <div className="flex gap-1 text-[13px]">
          {(['today', 'all'] as Tab[]).map((k) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={cn(
                'px-3 py-1.5 rounded-md',
                tab === k
                  ? 'bg-[var(--abu-bg-active)] text-[var(--abu-text-primary)]'
                  : 'text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)]'
              )}
            >
              {k === 'today' ? t.todos.tabToday : t.todos.tabAll}
            </button>
          ))}
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="px-6 py-4">
          {list.length === 0 ? (
            <div className="px-6 py-10 text-center text-[var(--abu-text-muted)] text-[14px]">
              {t.todos.empty}
            </div>
          ) : (
            <div className="space-y-0.5">
              {list.map((todo) => (
                <TodoItem
                  key={todo.id}
                  todo={todo}
                  onToggle={() => toggleStatus(todo.id)}
                  onDelete={() => deleteTodo(todo.id)}
                />
              ))}
            </div>
          )}
        </div>
      </ScrollArea>

      <div className="px-6 py-4 border-t border-[var(--abu-border)] bg-[var(--abu-bg-subtle)] flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
          placeholder={t.todos.placeholder}
          className="flex-1"
        />
        <Button onClick={handleAdd} disabled={!draft.trim()}>
          <Plus className="h-4 w-4 mr-1" />
          {t.todos.newTodo}
        </Button>
      </div>
    </div>
  );
}
