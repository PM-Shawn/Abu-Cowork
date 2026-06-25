import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import type { Todo, TodoStatus, TodoAssignee, TodoPriority, TodoSource } from '../types/todo';

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

function isSameDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear()
    && da.getMonth() === db.getMonth()
    && da.getDate() === db.getDate();
}

interface CreateTodoInput {
  title: string;
  source: TodoSource;
  notes?: string;
  assignee?: TodoAssignee;
  priority?: TodoPriority;
  dueAt?: number;
  sourceConversationId?: string;
  projectId?: string;
}

interface TodoState {
  todos: Record<string, Todo>;
}

interface TodoActions {
  createTodo: (input: CreateTodoInput) => string;
  updateTodo: (id: string, data: Partial<Pick<Todo, 'title' | 'notes' | 'priority' | 'dueAt' | 'projectId' | 'assignee'>>) => void;
  deleteTodo: (id: string) => void;
  toggleStatus: (id: string) => void;
  setStatus: (id: string, status: TodoStatus) => void;
  linkConversation: (id: string, conversationId: string) => void;
  getOpenTodos: () => Todo[];
  getTodayCompleted: () => Todo[];
  getTodosByProject: (projectId: string) => Todo[];
}

export type TodoStore = TodoState & TodoActions;

export const useTodosStore = create<TodoStore>()(
  persist(
    immer((set, get) => ({
      todos: {},

      createTodo: (input) => {
        const id = generateId();
        const now = Date.now();
        set((state) => {
          state.todos[id] = {
            id,
            title: input.title,
            notes: input.notes,
            status: 'todo',
            assignee: input.assignee ?? 'human',
            priority: input.priority,
            dueAt: input.dueAt,
            source: input.source,
            sourceConversationId: input.sourceConversationId,
            linkedConversationIds: [],
            projectId: input.projectId,
            createdAt: now,
            updatedAt: now,
          };
        });
        return id;
      },

      updateTodo: (id, data) => {
        set((state) => {
          const t = state.todos[id];
          if (!t) return;
          Object.assign(t, data);
          t.updatedAt = Date.now();
        });
      },

      deleteTodo: (id) => {
        set((state) => {
          delete state.todos[id];
        });
      },

      toggleStatus: (id) => {
        set((state) => {
          const t = state.todos[id];
          if (!t) return;
          if (t.status === 'done') {
            t.status = 'todo';
            t.completedAt = undefined;
          } else {
            t.status = 'done';
            t.completedAt = Date.now();
          }
          t.updatedAt = Date.now();
        });
      },

      setStatus: (id, status) => {
        set((state) => {
          const t = state.todos[id];
          if (!t) return;
          t.status = status;
          if (status === 'done') t.completedAt = Date.now();
          if (status !== 'done') t.completedAt = undefined;
          t.updatedAt = Date.now();
        });
      },

      linkConversation: (id, conversationId) => {
        set((state) => {
          const t = state.todos[id];
          if (!t) return;
          if (!t.linkedConversationIds.includes(conversationId)) {
            t.linkedConversationIds.push(conversationId);
            t.updatedAt = Date.now();
          }
        });
      },

      getOpenTodos: () => {
        return Object.values(get().todos)
          .filter((t) => t.status === 'todo' || t.status === 'in_progress')
          .sort((a, b) => b.createdAt - a.createdAt);
      },

      getTodayCompleted: () => {
        const now = Date.now();
        return Object.values(get().todos)
          .filter((t) => t.status === 'done' && t.completedAt && isSameDay(t.completedAt, now))
          .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
      },

      getTodosByProject: (projectId) => {
        return Object.values(get().todos)
          .filter((t) => t.projectId === projectId)
          .sort((a, b) => b.createdAt - a.createdAt);
      },
    })),
    {
      name: 'abu-todos',
      version: 1,
      partialize: (state) => ({ todos: state.todos }),
    },
  ),
);
