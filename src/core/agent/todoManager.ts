/**
 * Todo Manager — structured task tracking for agent planning
 *
 * Similar to Claude Code's TodoWrite/TodoRead pattern.
 * Todo state is injected into the system prompt each turn so the agent
 * always sees its current plan and progress.
 *
 * Per-conversation todo lists, keyed by conversationId.
 */

/** Todo item status */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

/** A single todo item */
export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
  createdAt: number;
  updatedAt: number;
}

// Per-conversation todo lists
const todoLists = new Map<string, TodoItem[]>();

// Listeners for state changes
const listeners = new Set<() => void>();

function notifyListeners() {
  listeners.forEach(fn => fn());
}

function generateTodoId(): string {
  return `todo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Get all todos for a conversation
 */
export function getTodos(conversationId: string): TodoItem[] {
  return todoLists.get(conversationId) ?? [];
}

/**
 * Add a todo item
 */
export function addTodo(conversationId: string, content: string): TodoItem {
  const todos = todoLists.get(conversationId) ?? [];
  const item: TodoItem = {
    id: generateTodoId(),
    content,
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  todos.push(item);
  todoLists.set(conversationId, todos);
  notifyListeners();
  return item;
}

/**
 * Update a todo item's status
 */
export function updateTodo(
  conversationId: string,
  todoId: string,
  updates: { status?: TodoStatus; content?: string }
): TodoItem | null {
  const todos = todoLists.get(conversationId);
  if (!todos) return null;

  // Support 1-based index (LLM sees sequential numbers in prompt) or real ID
  const item = /^\d+$/.test(todoId)
    ? todos[parseInt(todoId, 10) - 1]
    : todos.find(t => t.id === todoId);
  if (!item) return null;

  if (updates.status) item.status = updates.status;
  if (updates.content) item.content = updates.content;
  item.updatedAt = Date.now();

  notifyListeners();
  return item;
}

/**
 * Remove a todo item
 */
export function removeTodo(conversationId: string, todoId: string): boolean {
  const todos = todoLists.get(conversationId);
  if (!todos) return false;

  // Support 1-based index or real ID
  const index = /^\d+$/.test(todoId)
    ? parseInt(todoId, 10) - 1
    : todos.findIndex(t => t.id === todoId);
  if (index < 0 || index >= todos.length) return false;

  todos.splice(index, 1);
  notifyListeners();
  return true;
}

/**
 * Replace all todos for a conversation (bulk write)
 */
export function setTodos(conversationId: string, items: Array<{ content: string; status?: TodoStatus }>): TodoItem[] {
  const todos: TodoItem[] = items.map(item => ({
    id: generateTodoId(),
    content: item.content,
    status: item.status ?? 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }));
  todoLists.set(conversationId, todos);
  notifyListeners();
  return todos;
}

/**
 * Clear all todos for a conversation
 */
export function clearTodos(conversationId: string): void {
  todoLists.delete(conversationId);
  notifyListeners();
}

/**
 * Format todos as a string for injection into system prompt
 */
export function formatTodosForPrompt(conversationId: string): string {
  const todos = getTodos(conversationId);
  if (todos.length === 0) return '';

  const statusEmoji: Record<TodoStatus, string> = {
    pending: '⬜',
    in_progress: '🔄',
    completed: '✅',
    cancelled: '❌',
  };

  const lines = todos.map((t, i) =>
    `${i + 1}. ${statusEmoji[t.status]} [${t.status}] ${t.content}`
  );

  const completed = todos.filter(t => t.status === 'completed').length;
  const total = todos.length;

  return `## 当前任务计划 (${completed}/${total} 已完成)\n${lines.join('\n')}`;
}

/**
 * Subscribe to todo state changes (for useSyncExternalStore)
 */
export function subscribeToTodos(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}
