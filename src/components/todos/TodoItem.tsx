import { memo } from 'react';
import type { Todo } from '@/types/todo';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Pressable } from '@/components/ds/pressable';
import { Tag } from '@/components/ds/tag';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

interface TodoItemProps {
  todo: Todo;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onClick?: () => void;
}

/**
 * One row of the todo list. The list can hold hundreds of rows, so a row mounts no tooltip
 * root (its two icon buttons are named for screen readers only), is `memo`, and takes handlers
 * that stay the same between renders: typing in the inline form or changing one todo draws no
 * other row again.
 */
const TodoItem = memo(function TodoItem({ todo, onToggle, onDelete, onClick }: TodoItemProps) {
  const { t } = useI18n();
  const done = todo.status === 'done';
  const priorityLabel = todo.priority === 'high' ? t.todos.priorityHigh
    : todo.priority === 'low' ? t.todos.priorityLow
    : todo.priority === 'medium' ? t.todos.priorityMedium
    : null;
  const hasNotes = typeof todo.notes === 'string' && todo.notes.trim().length > 0;
  // These two names have no translation yet; they stay as they were.
  const toggleName = done ? 'reopen' : 'complete';
  return (
    <div
      data-todo-row={todo.id}
      onClick={onClick}
      className={cn(
        'group flex items-start gap-3 rounded-control px-3 py-2 hover:bg-fill-hover',
        done && 'opacity-60',
      )}
    >
      <Pressable
        onClick={(e) => { e.stopPropagation(); onToggle(todo.id); }}
        className={cn('shrink-0 rounded-control pt-0.5', done ? 'text-label' : 'text-label-tertiary hover:text-label')}
        aria-label={toggleName}
      >
        <Icon icon={done ? AppIcons.success : AppIcons.todoOpen} size="lg" />
      </Pressable>
      <div className="min-w-0 flex-1">
        <div className={cn('truncate text-ui text-label', done && 'text-label-tertiary line-through')}>
          {todo.title}
        </div>
        {hasNotes && (
          <div className={cn(
            'mt-1 line-clamp-3 whitespace-pre-wrap text-ui-sm text-label-secondary',
            done && 'line-through',
          )}>
            {todo.notes}
          </div>
        )}
      </div>
      {priorityLabel && (
        <Tag tone={todo.priority === 'high' ? 'danger' : todo.priority === 'medium' ? 'warning' : 'neutral'}>
          {priorityLabel}
        </Tag>
      )}
      {todo.assignee === 'agent' && <Tag>{t.todos.assigneeAgent}</Tag>}
      <Pressable
        aria-label={t.common.delete}
        onClick={(e) => { e.stopPropagation(); onDelete(todo.id); }}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-control text-label-secondary opacity-0 hover:bg-fill-hover hover:text-label group-hover:opacity-100 group-focus-within:opacity-100"
      >
        <Icon icon={AppIcons.delete} size="sm" />
      </Pressable>
    </div>
  );
});

export default TodoItem;
