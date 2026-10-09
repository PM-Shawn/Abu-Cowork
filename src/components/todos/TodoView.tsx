import { memo, useCallback, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ds/button';
import { EmptyState } from '@/components/ds/empty-state';
import { AppIcons } from '@/components/ds/icons';
import { Pressable } from '@/components/ds/pressable';
import { ScrollArea } from '@/components/ds/scroll-area';
import { TextArea } from '@/components/ds/text-area';
import { TextField } from '@/components/ds/text-field';
import { useTodosStore } from '@/stores/todosStore';
import { useI18n } from '@/i18n';
import { windowDragRowProps } from '@/utils/windowDrag';
import { cn } from '@/lib/utils';
import TodoItem from './TodoItem';
import { useRowFocus } from '@/components/common/useRowFocus';

type Tab = 'today' | 'all';

function isSameDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear()
    && da.getMonth() === db.getMonth()
    && da.getDate() === db.getDate();
}

/**
 * The todos page. `App` renders for every piece of a streamed reply, so the page takes no props
 * and reads one store field at a time.
 */
const TodoView = memo(function TodoView() {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('today');
  const [editorOpen, setEditorOpen] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [notesDraft, setNotesDraft] = useState('');
  // IME composition guard — see handleTitleKey below for why a ref + setTimeout(0)
  // is required on top of the standard isComposing flag (WebKit fires keydown
  // for Enter AFTER compositionend, with isComposing already false).
  const composingRef = useRef(false);

  // Subscribe to raw record + derive — selectors that return new arrays would
  // cause "Maximum update depth exceeded" under Zustand's default `===` equality.
  const todos = useTodosStore((s) => s.todos);
  const createTodo = useTodosStore((s) => s.createTodo);
  const toggleStatus = useTodosStore((s) => s.toggleStatus);
  const deleteTodo = useTodosStore((s) => s.deleteTodo);
  // A deleted row and the closed form take the focused control with them.
  const { root, fallback, note } = useRowFocus('data-todo-row');

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
    note(null);
    createTodo({ title, source: 'manual', notes: notes || undefined });
    setTitleDraft('');
    setNotesDraft('');
    setEditorOpen(false);
  };

  const handleCancel = () => {
    note(null);
    setTitleDraft('');
    setNotesDraft('');
    setEditorOpen(false);
  };

  // Stable for the memoized rows.
  const handleDelete = useCallback((id: string) => {
    note(id);
    deleteTodo(id);
  }, [note, deleteTodo]);

  // Guard Enter handler against IME composition:
  //   - `e.nativeEvent.isComposing` covers most engines mid-composition
  //   - BUT in WebKit (Tauri WKWebView) when the user presses Enter to commit
  //     a candidate, compositionend fires first → keydown for Enter then fires
  //     with isComposing === false, so the flag check alone fails.
  //   - Workaround: track composition state in a ref, and defer the reset
  //     past the synthesized Enter keydown via setTimeout(0).
  const handleCompositionStart = () => { composingRef.current = true; };
  const handleCompositionEnd = () => {
    setTimeout(() => { composingRef.current = false; }, 0);
  };
  const handleTitleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (composingRef.current || e.nativeEvent.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Escape') {
      handleCancel();
    }
  };

  return (
    <div className="flex h-full flex-col bg-surface">
      <div {...windowDragRowProps()} className="flex items-center justify-between border-b border-separator px-6 py-4">
        <h1 className="text-title text-label">{t.todos.title}</h1>
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            {(['today', 'all'] as Tab[]).map((k) => (
              <Pressable
                key={k}
                aria-pressed={tab === k}
                onClick={() => setTab(k)}
                className={cn(
                  'h-7 rounded-control px-3 text-ui',
                  tab === k ? 'bg-fill-selected text-label' : 'text-label-secondary hover:bg-fill-hover',
                )}
              >
                {k === 'today' ? t.todos.tabToday : t.todos.tabAll}
              </Pressable>
            ))}
          </div>
          <Button ref={fallback} variant="primary" icon={AppIcons.add} onClick={() => setEditorOpen(true)} disabled={editorOpen}>
            {t.todos.newTodo}
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div ref={root} className="px-6 py-4">
          {editorOpen && (
            <div className="mb-3 space-y-2 rounded-panel border border-separator bg-surface p-3">
              <TextField
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={handleTitleKey}
                onCompositionStart={handleCompositionStart}
                onCompositionEnd={handleCompositionEnd}
                placeholder={t.todos.placeholder}
              />
              <TextArea
                value={notesDraft}
                onChange={(e) => setNotesDraft(e.target.value)}
                placeholder={t.todos.notesPlaceholder}
                rows={3}
              />
              <div className="flex justify-end gap-2">
                <Button variant="plain" size="sm" icon={AppIcons.close} onClick={handleCancel}>
                  {t.common.cancel}
                </Button>
                <Button variant="secondary" size="sm" onClick={handleSubmit} disabled={!titleDraft.trim()}>
                  {t.common.confirm}
                </Button>
              </div>
            </div>
          )}
          {list.length === 0 && !editorOpen ? (
            <EmptyState icon={AppIcons.todos} title={t.todos.empty} />
          ) : (
            <div className="space-y-1">
              {list.map((todo) => (
                <TodoItem
                  key={todo.id}
                  todo={todo}
                  onToggle={toggleStatus}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
});

export default TodoView;
