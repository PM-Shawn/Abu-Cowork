import { CheckCircle2, Circle, Trash2 } from 'lucide-react';
import type { Todo } from '@/types/todo';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

interface TodoItemProps {
  todo: Todo;
  onToggle: () => void;
  onDelete: () => void;
  onClick?: () => void;
}

export default function TodoItem({ todo, onToggle, onDelete, onClick }: TodoItemProps) {
  const { t } = useI18n();
  const done = todo.status === 'done';
  const priorityLabel = todo.priority === 'high' ? t.todos.priorityHigh
    : todo.priority === 'low' ? t.todos.priorityLow
    : todo.priority === 'medium' ? t.todos.priorityMedium
    : null;
  const hasNotes = typeof todo.notes === 'string' && todo.notes.trim().length > 0;
  return (
    <div
      onClick={onClick}
      className={cn(
        'group flex items-start gap-3 px-3 py-2.5 rounded-lg hover:bg-[var(--abu-bg-hover)] cursor-pointer',
        done && 'opacity-60',
      )}
    >
      <button
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
        className="shrink-0 text-[var(--abu-text-tertiary)] hover:text-[var(--abu-clay)] pt-0.5"
        aria-label={done ? 'reopen' : 'complete'}
      >
        {done ? <CheckCircle2 className="h-5 w-5 text-[var(--abu-clay)]" /> : <Circle className="h-5 w-5" />}
      </button>
      <div className="flex-1 min-w-0">
        <div className={cn('text-[14px] truncate', done && 'line-through text-[var(--abu-text-muted)]')}>
          {todo.title}
        </div>
        {hasNotes && (
          <div className={cn(
            'text-[12px] text-[var(--abu-text-muted)] whitespace-pre-wrap line-clamp-3 mt-0.5',
            done && 'line-through',
          )}>
            {todo.notes}
          </div>
        )}
      </div>
      {priorityLabel && (
        <span className={cn(
          'shrink-0 text-[11px] px-1.5 py-0.5 rounded',
          todo.priority === 'high' ? 'bg-red-100 text-red-700'
            : todo.priority === 'low' ? 'bg-gray-100 text-gray-600'
            : 'bg-amber-100 text-amber-700',
        )}>
          {priorityLabel}
        </span>
      )}
      {todo.assignee === 'agent' && (
        <span className="shrink-0 text-[11px] px-1.5 py-0.5 rounded bg-[var(--abu-clay-bg-15)] text-[var(--abu-clay)]">
          {t.todos.assigneeAgent}
        </span>
      )}
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="opacity-0 group-hover:opacity-100 p-1 text-[var(--abu-text-tertiary)] hover:text-red-500 shrink-0"
        aria-label="delete"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
