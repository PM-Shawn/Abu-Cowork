import { describe, it, expect, beforeEach } from 'vitest';
import { useTodosStore } from './todosStore';

describe('todosStore', () => {
  beforeEach(() => {
    useTodosStore.setState({ todos: {} });
  });

  describe('createTodo', () => {
    it('creates a manual todo with default fields', () => {
      const id = useTodosStore.getState().createTodo({
        title: '写文章',
        source: 'manual',
      });
      const todo = useTodosStore.getState().todos[id];
      expect(todo).toBeDefined();
      expect(todo.title).toBe('写文章');
      expect(todo.status).toBe('todo');
      expect(todo.assignee).toBe('human');
      expect(todo.linkedConversationIds).toEqual([]);
      expect(todo.createdAt).toBeGreaterThan(0);
    });

    it('respects explicit assignee/priority/dueAt', () => {
      const id = useTodosStore.getState().createTodo({
        title: '生成草稿',
        source: 'manual',
        assignee: 'agent',
        priority: 'high',
        dueAt: 1_800_000_000_000,
      });
      const todo = useTodosStore.getState().todos[id];
      expect(todo.assignee).toBe('agent');
      expect(todo.priority).toBe('high');
      expect(todo.dueAt).toBe(1_800_000_000_000);
    });
  });

  describe('toggleStatus', () => {
    it('marks an open todo as done with completedAt', () => {
      const id = useTodosStore.getState().createTodo({ title: 't', source: 'manual' });
      useTodosStore.getState().toggleStatus(id);
      const t = useTodosStore.getState().todos[id];
      expect(t.status).toBe('done');
      expect(t.completedAt).toBeGreaterThan(0);
    });

    it('reopens a done todo and clears completedAt', () => {
      const id = useTodosStore.getState().createTodo({ title: 't', source: 'manual' });
      useTodosStore.getState().toggleStatus(id);
      useTodosStore.getState().toggleStatus(id);
      const t = useTodosStore.getState().todos[id];
      expect(t.status).toBe('todo');
      expect(t.completedAt).toBeUndefined();
    });
  });

  describe('updateTodo', () => {
    it('updates title and bumps updatedAt', async () => {
      const id = useTodosStore.getState().createTodo({ title: 'old', source: 'manual' });
      const before = useTodosStore.getState().todos[id].updatedAt;
      await new Promise((r) => setTimeout(r, 5));
      useTodosStore.getState().updateTodo(id, { title: 'new' });
      const t = useTodosStore.getState().todos[id];
      expect(t.title).toBe('new');
      expect(t.updatedAt).toBeGreaterThan(before);
    });
  });

  describe('deleteTodo', () => {
    it('removes the todo', () => {
      const id = useTodosStore.getState().createTodo({ title: 't', source: 'manual' });
      useTodosStore.getState().deleteTodo(id);
      expect(useTodosStore.getState().todos[id]).toBeUndefined();
    });
  });

  describe('selectors', () => {
    it('getOpenTodos returns non-done, non-cancelled, sorted by createdAt desc', () => {
      const a = useTodosStore.getState().createTodo({ title: 'a', source: 'manual' });
      const b = useTodosStore.getState().createTodo({ title: 'b', source: 'manual' });
      useTodosStore.getState().toggleStatus(a);
      const open = useTodosStore.getState().getOpenTodos();
      expect(open.map((t) => t.id)).toEqual([b]);
    });

    it('getTodayCompleted returns done todos completed today', () => {
      const id = useTodosStore.getState().createTodo({ title: 't', source: 'manual' });
      useTodosStore.getState().toggleStatus(id);
      const today = useTodosStore.getState().getTodayCompleted();
      expect(today.map((t) => t.id)).toContain(id);
    });
  });
});
