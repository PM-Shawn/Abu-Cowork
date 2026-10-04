import { memo } from 'react';
import type { Todo } from '@/types/todo';
import { IconButton } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Pressable } from '@/components/ds/pressable';
import { Tag } from '@/components/ds/tag';
import { Tooltip } from '@/components/ds/tooltip';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

interface TodoItemProps {
  todo: Todo;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onClick?: () => void;
}

/**
 * One row of the todo list. The list can hold hundreds of rows and each row mounts two tooltips,
 * so the row is `memo` and takes handlers that stay the same between renders: typing in the
 * inline form or changing one todo draws no other row again.
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
      <Tooltip content={toggleName}>
        <Pressable
          onClick={(e) => { e.stopPropagation(); onToggle(todo.id); }}
          className={cn('shrink-0 rounded-control pt-0.5', done ? 'text-label' : 'text-label-tertiary hover:text-label')}
          aria-label={toggleName}
        >
          <Icon icon={done ? AppIcons.success : AppIcons.todoOpen} size="lg" />
        </Pressable>
      </Tooltip>
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
      <IconButton
        size="sm"
        icon={AppIcons.delete}
        label={t.common.delete}
        onClick={(e) => { e.stopPropagation(); onDelete(todo.id); }}
        className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
      />
    </div>
  );
});

export default TodoItem;
