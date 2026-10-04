// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { DesignSystemProvider } from '@/components/ds/provider';
import { getI18n } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useTodosStore } from '@/stores/todosStore';
import type { Todo } from '@/types/todo';
import TodoView from './TodoView';

// The real pressable, counted when it is the complete / reopen button: a todo row draws exactly
// one, so the count says which rows were drawn again.
const drawn = vi.hoisted(() => ({ rows: 0 }));
vi.mock('@/components/ds/pressable', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/pressable')>();
  return {
    Pressable: (props: Parameters<typeof actual.Pressable>[0]) => {
      if (props['aria-label'] === 'complete' || props['aria-label'] === 'reopen') drawn.rows += 1;
      return <actual.Pressable {...props} />;
    },
  };
});

const t = () => getI18n();
const NOW = new Date(2026, 9, 5, 12, 0, 0).getTime();
const DAY = 86_400_000;

function todo(id: string, title: string, secondsOld: number, more: Partial<Todo> = {}): Todo {
  const createdAt = NOW - secondsOld * 1000;
  return { id, title, status: 'todo', assignee: 'human', source: 'manual', linkedConversationIds: [], createdAt, updatedAt: createdAt, ...more };
}

const urgent = todo('urgent', 'Send the contract', 1, { priority: 'high' });
const running = todo('running', 'Draft the report', 2, { status: 'in_progress', assignee: 'agent', priority: 'medium', notes: 'First line\nSecond line' });
const someday = todo('someday', 'Tidy the desk', 3, { priority: 'low' });
const doneToday = todo('done-today', 'Call the bank', 40, { status: 'done', completedAt: NOW - 500 });
const doneEarlier = todo('done-earlier', 'Renew the passport', 50, { status: 'done', completedAt: NOW - 3 * DAY });
const ALL = [urgent, running, someday, doneToday, doneEarlier];
const TITLES = ALL.map((entry) => entry.title);

// Every store action the page may call, in the order it called them. Each still does its work.
const calls: unknown[][] = [];
const actions = useTodosStore.getState();
// The chat store as it was: the render-count tests put a conversation into it.
const { conversations } = useChatStore.getState();

function seed(todos: Todo[]) {
  useTodosStore.setState({ todos: Object.fromEntries(todos.map((entry) => [entry.id, entry])) });
}

const show = () => render(<TodoView />, { wrapper: DesignSystemProvider });
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const shownTitles = () => TITLES
  .map((title) => screen.queryByText(title))
  .filter((element): element is HTMLElement => element !== null)
  .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
  .map((element) => element.textContent);
// The row of one todo: the title sits in the text column, which sits in the row.
const row = (entry: Todo) => within(screen.getByText(entry.title).parentElement?.parentElement as HTMLElement);
const titleField = () => screen.getByPlaceholderText(t().todos.placeholder) as HTMLInputElement;
const notesField = () => screen.getByPlaceholderText(t().todos.notesPlaceholder) as HTMLTextAreaElement;
const openEditor = () => fireEvent.click(button(t().todos.newTodo));
const type = (field: HTMLElement, value: string) => fireEvent.change(field, { target: { value } });
const created = () => calls.filter(([name]) => name === 'createTodo');

describe('TodoView', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    calls.length = 0;
    useTodosStore.setState({
      createTodo: (input) => { calls.push(['createTodo', input]); return actions.createTodo(input); },
      toggleStatus: (id) => { calls.push(['toggleStatus', id]); actions.toggleStatus(id); },
      deleteTodo: (id) => { calls.push(['deleteTodo', id]); actions.deleteTodo(id); },
    });
    seed(ALL);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useTodosStore.setState({ ...actions, todos: {} });
    useChatStore.setState({ conversations });
  });

  describe('the two tabs', () => {
    it('opens on today: what is still open, newest first, then what was done today', () => {
      show();
      expect(shownTitles()).toEqual([urgent.title, running.title, someday.title, doneToday.title]);
    });

    it('adds everything done earlier under All', () => {
      show();
      fireEvent.click(button(t().todos.tabAll));
      expect(shownTitles()).toEqual(TITLES);
      fireEvent.click(button(t().todos.tabToday));
      expect(shownTitles()).toHaveLength(4);
    });

    it('says there is nothing for today when the list is empty', () => {
      seed([doneEarlier]);
      show();
      expect(screen.getByText(t().todos.empty)).toBeInTheDocument();
      fireEvent.click(button(t().todos.tabAll));
      expect(screen.queryByText(t().todos.empty)).toBeNull();
    });
  });

  describe('one todo', () => {
    it('shows its notes, its priority and that Abu has it', () => {
      show();
      expect(row(running).getByText(/First line\s+Second line/)).toBeInTheDocument();
      expect(row(urgent).getByText(t().todos.priorityHigh)).toBeInTheDocument();
      expect(row(running).getByText(t().todos.priorityMedium)).toBeInTheDocument();
      expect(row(someday).getByText(t().todos.priorityLow)).toBeInTheDocument();
      expect(row(running).getByText(t().todos.assigneeAgent)).toBeInTheDocument();
      expect(row(urgent).queryByText(t().todos.assigneeAgent)).toBeNull();
    });

    it('completes an open todo and reopens a done one', () => {
      show();
      fireEvent.click(row(urgent).getByRole('button', { name: 'complete' }));
      fireEvent.click(row(doneToday).getByRole('button', { name: 'reopen' }));
      expect(calls).toEqual([['toggleStatus', 'urgent'], ['toggleStatus', 'done-today']]);
      expect(row(urgent).getByRole('button', { name: 'reopen' })).toBeInTheDocument();
      expect(row(doneToday).getByRole('button', { name: 'complete' })).toBeInTheDocument();
    });

    it('deletes the todo its delete button belongs to', () => {
      show();
      fireEvent.click(row(running).getByRole('button', { name: /^delete$/i }));
      expect(calls).toEqual([['deleteTodo', 'running']]);
      expect(shownTitles()).toEqual([urgent.title, someday.title, doneToday.title]);
    });
  });

  describe('a new todo', () => {
    it('opens a form on its title, and takes no second form while that one is open', () => {
      show();
      expect(screen.queryByPlaceholderText(t().todos.placeholder)).toBeNull();
      openEditor();
      expect(titleField()).toHaveFocus();
      expect(button(t().todos.newTodo)).toBeDisabled();
      expect(button(t().common.confirm)).toBeDisabled();
    });

    it('hides the empty words while the form is open', () => {
      seed([]);
      show();
      openEditor();
      expect(screen.queryByText(t().todos.empty)).toBeNull();
    });

    it('creates it on Enter, with the title and the notes trimmed, and closes the form', () => {
      show();
      openEditor();
      type(titleField(), '  Write the weekly note  ');
      type(notesField(), '  for Friday\nsecond line  ');
      fireEvent.keyDown(titleField(), { key: 'Enter' });
      expect(calls).toEqual([['createTodo', { title: 'Write the weekly note', source: 'manual', notes: 'for Friday\nsecond line' }]]);
      expect(screen.queryByPlaceholderText(t().todos.placeholder)).toBeNull();
      expect(screen.getByText('Write the weekly note')).toBeInTheDocument();
      expect(button(t().todos.newTodo)).toBeEnabled();
      // The next form starts empty.
      openEditor();
      expect(titleField().value).toBe('');
      expect(notesField().value).toBe('');
    });

    it('creates it from the confirm button, with no notes when none were written', () => {
      show();
      openEditor();
      type(titleField(), 'Water the plants');
      fireEvent.click(button(t().common.confirm));
      expect(calls).toEqual([['createTodo', { title: 'Water the plants', source: 'manual', notes: undefined }]]);
    });

    it('creates nothing from a title of spaces', () => {
      show();
      openEditor();
      type(titleField(), '   ');
      expect(button(t().common.confirm)).toBeDisabled();
      fireEvent.keyDown(titleField(), { key: 'Enter' });
      expect(calls).toEqual([]);
      expect(titleField()).toBeInTheDocument();
    });

    it('does not create it from the Enter that picks an input-method candidate', () => {
      show();
      openEditor();
      type(titleField(), '写周报');
      fireEvent.compositionStart(titleField());
      fireEvent.keyDown(titleField(), { key: 'Enter' });
      fireEvent.keyDown(titleField(), { key: 'Escape' });
      expect(created()).toEqual([]);
      expect(titleField().value).toBe('写周报');

      // WebKit: the composition ends first, and the Enter that ended it arrives right after.
      fireEvent.compositionEnd(titleField());
      fireEvent.keyDown(titleField(), { key: 'Enter' });
      expect(created()).toEqual([]);

      act(() => { vi.advanceTimersByTime(0); });
      fireEvent.keyDown(titleField(), { key: 'Enter' });
      expect(created()).toEqual([['createTodo', { title: '写周报', source: 'manual', notes: undefined }]]);
    });

    it('does not create it from an Enter the browser marks as composing', () => {
      show();
      openEditor();
      type(titleField(), '写周报');
      fireEvent.keyDown(titleField(), { key: 'Enter', isComposing: true });
      expect(created()).toEqual([]);
    });

    it('drops the draft on Escape and from the cancel button', () => {
      show();
      openEditor();
      type(titleField(), 'Half a thought');
      type(notesField(), 'and a note');
      fireEvent.keyDown(titleField(), { key: 'Escape' });
      expect(screen.queryByPlaceholderText(t().todos.placeholder)).toBeNull();
      expect(calls).toEqual([]);

      openEditor();
      expect(titleField().value).toBe('');
      expect(notesField().value).toBe('');
      type(titleField(), 'Another half');
      fireEvent.click(button(t().common.cancel));
      expect(screen.queryByPlaceholderText(t().todos.placeholder)).toBeNull();
      openEditor();
      expect(titleField().value).toBe('');
      expect(calls).toEqual([]);
    });
  });

  describe('on the design system', () => {
    // The last thing the user did was press a key.
    const byKeyboard = (element: HTMLElement) => {
      fireEvent.keyDown(document.body, { key: 'Tab' });
      element.focus();
    };

    it('says which tab is in view', () => {
      show();
      expect(button(t().todos.tabToday)).toHaveAttribute('aria-pressed', 'true');
      expect(button(t().todos.tabAll)).toHaveAttribute('aria-pressed', 'false');
      fireEvent.click(button(t().todos.tabAll));
      expect(button(t().todos.tabAll)).toHaveAttribute('aria-pressed', 'true');
      expect(button(t().todos.tabAll)).toHaveClass('bg-fill-selected');
    });

    it('has one filled button, the one that starts a new todo; the form confirms with a quiet one', () => {
      show();
      openEditor();
      expect(button(t().todos.newTodo)).toHaveClass('bg-emphasis');
      expect(button(t().common.confirm)).toHaveClass('bg-fill');
      expect(button(t().common.cancel)).not.toHaveClass('bg-fill');
      expect(document.querySelectorAll('.bg-emphasis')).toHaveLength(1);
    });

    it('shows the empty list as an empty state with the todos icon', () => {
      seed([]);
      show();
      const words = screen.getByText(t().todos.empty);
      expect(words).toHaveClass('text-title');
      expect(words.previousElementSibling?.tagName.toLowerCase()).toBe('svg');
    });

    it('names the three buttons of a row: complete or reopen as they were, delete in the language of the app', () => {
      show();
      expect(row(urgent).getAllByRole('button').map((element) => element.getAttribute('aria-label'))).toEqual(['complete', t().common.delete]);
      expect(row(doneToday).getAllByRole('button').map((element) => element.getAttribute('aria-label'))).toEqual(['reopen', t().common.delete]);
    });

    // A tooltip trigger carries data-state. The list can hold hundreds of rows, and a row mounts
    // no tooltip root.
    it('mounts no tooltip on a row: neither button is a tooltip trigger, and focus by keyboard shows none', () => {
      show();
      const [complete, remove] = row(urgent).getAllByRole('button');
      expect(complete).not.toHaveAttribute('data-state');
      expect(remove).not.toHaveAttribute('data-state');
      byKeyboard(complete);
      fireEvent.focus(complete);
      expect(screen.queryByRole('tooltip')).toBeNull();
    });

    it('shows the delete button when the pointer is on the row or the focus is inside it', () => {
      show();
      const remove = row(urgent).getByRole('button', { name: t().common.delete });
      expect(remove).toHaveClass('opacity-0');
      expect(remove).toHaveClass('group-hover:opacity-100');
      expect(remove).toHaveClass('group-focus-within:opacity-100');
    });

    it('shows the priority and the assignee as tags', () => {
      show();
      expect(row(urgent).getByText(t().todos.priorityHigh)).toHaveClass('bg-danger-soft');
      expect(row(running).getByText(t().todos.priorityMedium)).toHaveClass('bg-warning-soft');
      expect(row(someday).getByText(t().todos.priorityLow)).toHaveClass('bg-fill');
      expect(row(running).getByText(t().todos.assigneeAgent)).toHaveClass('bg-fill');
    });

    it('strikes a done todo through and leaves an open one plain', () => {
      show();
      expect(screen.getByText(doneToday.title)).toHaveClass('line-through');
      expect(screen.getByText(urgent.title)).not.toHaveClass('line-through');
    });

    describe('keyboard focus when a control leaves', () => {
      const remove = (entry: Todo) => {
        const target = row(entry).getByRole('button', { name: t().common.delete });
        byKeyboard(target);
        fireEvent.click(target);
      };

      it('goes to the row that took the place of a deleted one', () => {
        show();
        remove(running);
        expect(row(someday).getByRole('button', { name: 'complete' })).toHaveFocus();
      });

      it('goes to the row before it when the last one is deleted', () => {
        show();
        remove(doneToday);
        expect(row(someday).getByRole('button', { name: 'complete' })).toHaveFocus();
      });

      it('goes to the new-todo button when the only row is deleted', () => {
        seed([urgent]);
        show();
        remove(urgent);
        expect(button(t().todos.newTodo)).toHaveFocus();
      });

      it('goes to the new-todo button when the form closes: Escape, cancel and a created todo', () => {
        show();
        openEditor();
        fireEvent.keyDown(titleField(), { key: 'Escape' });
        expect(button(t().todos.newTodo)).toHaveFocus();

        openEditor();
        byKeyboard(button(t().common.cancel));
        fireEvent.click(button(t().common.cancel));
        expect(button(t().todos.newTodo)).toHaveFocus();

        openEditor();
        type(titleField(), 'Post the letter');
        fireEvent.keyDown(titleField(), { key: 'Enter' });
        expect(button(t().todos.newTodo)).toHaveFocus();
      });
    });

    describe('render count', () => {
      // Stands in for App, which reads the chat store and renders for every piece of a streamed reply.
      const app = { renders: 0 };
      function AppAround() {
        useChatStore((s) => s.conversations);
        app.renders += 1;
        return <TodoView />;
      }
      const streamPiece = (text: string) => {
        const { conversations } = useChatStore.getState();
        useChatStore.setState({
          conversations: {
            ...conversations,
            'conv-stream': {
              id: 'conv-stream', title: 'Streaming', createdAt: 1, updatedAt: 1, status: 'running',
              messages: [{ id: 'm1', role: 'assistant', content: text, timestamp: 1 }],
            },
          },
        });
      };
      const rowsDrawn = () => {
        const count = drawn.rows;
        drawn.rows = 0;
        return count;
      };

      it('does not draw again when the chat store changes and the app around it renders', () => {
        app.renders = 0;
        rowsDrawn();
        render(<DesignSystemProvider><AppAround /></DesignSystemProvider>);
        expect(rowsDrawn()).toBe(4);
        const around = app.renders;

        for (const text of ['Once', 'Once upon', 'Once upon a time']) act(() => streamPiece(text));

        expect(app.renders).toBe(around + 3);
        expect(rowsDrawn()).toBe(0);
      });

      it('draws no row again while a title is typed into the form', () => {
        show();
        openEditor();
        rowsDrawn();
        type(titleField(), 'W');
        type(titleField(), 'Wa');
        type(notesField(), 'a note');
        expect(rowsDrawn()).toBe(0);
      });

      it('draws only the row of the todo that changed', () => {
        show();
        rowsDrawn();
        fireEvent.click(row(urgent).getByRole('button', { name: 'complete' }));
        expect(rowsDrawn()).toBe(1);
      });
    });
  });
});
