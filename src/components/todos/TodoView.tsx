import { useMemo, useState, type KeyboardEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
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
  const [editorOpen, setEditorOpen] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [notesDraft, setNotesDraft] = useState('');

  // Subscribe to raw record + derive — selectors that return new arrays would
  // cause "Maximum update depth exceeded" under Zustand's default `===` equality.
  const todos = useTodosStore((s) => s.todos);
  const createTodo = useTodosStore((s) => s.createTodo);
  const toggleStatus = useTodosStore((s) => s.toggleStatus);
  const deleteTodo = useTodosStore((s) => s.deleteTodo);

  const openTodos = useMemo(
    () => Object.values(todos)
      .filter((tt) => tt.status === 'todo' || tt.status === 'in_progress')
      .sort((a, b) => b.createdAt - a.createdAt),
    [todos],
  );
  const todayDone = useMemo(() => {
    const now = Date.now();
    return Object.values(todos)
      .filter((tt) => tt.status === 'done' && tt.completedAt && isSameDay(tt.completedAt, now))
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
  }, [todos]);
  const allDone = useMemo(
    () => Object.values(todos)
      .filter((tt) => tt.status === 'done')
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0)),
    [todos],
  );

  const list = tab === 'today'
    ? [...openTodos, ...todayDone]
    : [...openTodos, ...allDone];

  const handleSubmit = () => {
    const title = titleDraft.trim();
    if (!title) return;
    const notes = notesDraft.trim();
    createTodo({ title, source: 'manual', notes: notes || undefined });
    setTitleDraft('');
    setNotesDraft('');
    setEditorOpen(false);
  };

  const handleCancel = () => {
    setTitleDraft('');
    setNotesDraft('');
    setEditorOpen(false);
  };

  // Guard Enter handler against IME composition: when typing English via Chinese
  // IME, pressing Enter to pick a candidate would otherwise fire submit.
  const handleTitleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Escape') {
      handleCancel();
    }
  };

  return (
    <div className="flex flex-col h-full bg-[var(--abu-bg-base)]">
      <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--abu-border)]">
        <h1 className="text-[18px] font-semibold text-[var(--abu-text-primary)]">{t.todos.title}</h1>
        <div className="flex items-center gap-2">
          <div className="flex gap-1 text-[13px]">
            {(['today', 'all'] as Tab[]).map((k) => (
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
                {k === 'today' ? t.todos.tabToday : t.todos.tabAll}
              </button>
            ))}
          </div>
          <Button onClick={() => setEditorOpen(true)} disabled={editorOpen}>
            <Plus className="h-4 w-4 mr-1" />
            {t.todos.newTodo}
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="px-6 py-4">
          {editorOpen && (
            <div className="mb-3 p-3 rounded-lg border border-[var(--abu-clay-40)] bg-[var(--abu-bg-card)] space-y-2">
              <Input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={handleTitleKey}
                placeholder={t.todos.placeholder}
                className="text-[14px]"
              />
              <Textarea
                value={notesDraft}
                onChange={(e) => setNotesDraft(e.target.value)}
                placeholder={t.todos.notesPlaceholder}
                className="text-[13px] min-h-[64px]"
                rows={3}
              />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={handleCancel}>
                  <X className="h-3.5 w-3.5 mr-1" />
                  {t.common.cancel}
                </Button>
                <Button size="sm" onClick={handleSubmit} disabled={!titleDraft.trim()}>
                  {t.common.confirm}
                </Button>
              </div>
            </div>
          )}
          {list.length === 0 && !editorOpen ? (
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
    </div>
  );
}
