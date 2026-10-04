// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { DesignSystemProvider } from '@/components/ds/provider';
import { format, getI18n } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useInboxStore } from '@/stores/inboxStore';
import { useTodosStore } from '@/stores/todosStore';
import type { InboxItem } from '@/types/todo';
import InboxView from './InboxView';

// The real item, counted: the page draws one per item, so the count says whether the page drew again.
const drawn = vi.hoisted(() => ({ items: 0 }));
vi.mock('./InboxItem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./InboxItem')>();
  return {
    default: (props: Parameters<typeof actual.default>[0]) => {
      drawn.items += 1;
      return <actual.default {...props} />;
    },
  };
});

const t = () => getI18n();

function item(id: string, type: InboxItem['type'], createdAt: number, more: Partial<InboxItem> = {}): InboxItem {
  return { id, type, summary: `Summary of ${id}`, unread: true, status: 'pending', createdAt, ...more };
}

const proposal = item('proposal', 'agent_proposed_todo', 60, { conversationId: 'conv-1', payload: { draft: { title: 'Book the venue' } } });
const confirmation = item('confirmation', 'agent_confirmation', 50);
const result = item('result', 'agent_result', 40);
const failure = item('failure', 'agent_error', 30);
const accepted = item('accepted', 'agent_proposed_todo', 20, { status: 'accepted', unread: false });
const ignored = item('ignored', 'agent_result', 10, { status: 'ignored', unread: false });
const ALL = [proposal, confirmation, result, failure, accepted, ignored];

// Every store action the page may call, in the order it called them. Each still does its work.
const calls: unknown[][] = [];
const inboxActions = useInboxStore.getState();
const todoActions = useTodosStore.getState();

function seed(items: InboxItem[]) {
  useInboxStore.setState({ items: Object.fromEntries(items.map((entry) => [entry.id, entry])) });
}

const show = () => render(<InboxView />, { wrapper: DesignSystemProvider });
// The card of one item: its summary is a direct child of the card.
const card = (entry: InboxItem) => within(screen.getByText(entry.summary).parentElement as HTMLElement);
const tab = (name: string) => screen.getByRole('button', { name });
const press = (entry: InboxItem, name: string) => fireEvent.click(card(entry).getByRole('button', { name }));
const shownSummaries = () => screen.queryAllByText(/^Summary of /).map((element) => element.textContent);
const buttonNames = (entry: InboxItem) => card(entry).queryAllByRole('button').map((element) => element.textContent);

describe('InboxView', () => {
  beforeEach(() => {
    calls.length = 0;
    useInboxStore.setState({
      markAllRead: () => { calls.push(['markAllRead']); inboxActions.markAllRead(); },
      markRead: (id) => { calls.push(['markRead', id]); inboxActions.markRead(id); },
      accept: (id) => { calls.push(['accept', id]); inboxActions.accept(id); },
      ignore: (id) => { calls.push(['ignore', id]); inboxActions.ignore(id); },
    });
    useTodosStore.setState({
      todos: {},
      createTodo: (input) => { calls.push(['createTodo', input]); return todoActions.createTodo(input); },
    });
    seed(ALL);
  });

  afterEach(() => {
    cleanup();
    useInboxStore.setState({ ...inboxActions, items: {} });
    useTodosStore.setState({ ...todoActions, todos: {} });
  });

  it('marks everything read on the way in', () => {
    show();
    expect(calls).toEqual([['markAllRead']]);
    expect(Object.values(useInboxStore.getState().items).some((entry) => entry.unread)).toBe(false);
  });

  describe('the two tabs', () => {
    it('opens on the pending items, newest first, and counts them', () => {
      show();
      expect(shownSummaries()).toEqual([proposal, confirmation, result, failure].map((entry) => entry.summary));
      expect(screen.getByText(format(t().inbox.pendingCount, { count: 4 }))).toBeInTheDocument();
    });

    it('lists the handled items as well under All', () => {
      show();
      fireEvent.click(tab(t().inboxTabs.all));
      expect(shownSummaries()).toEqual(ALL.map((entry) => entry.summary));
      fireEvent.click(tab(t().inboxTabs.pending));
      expect(shownSummaries()).toHaveLength(4);
    });

    it('says the inbox is empty when the tab in view has nothing, and shows no count', () => {
      seed([accepted, ignored]);
      show();
      expect(screen.getByText(t().inbox.empty)).toBeInTheDocument();
      expect(screen.queryByText(/pending$/)).toBeNull();
      fireEvent.click(tab(t().inboxTabs.all));
      expect(screen.queryByText(t().inbox.empty)).toBeNull();
      expect(shownSummaries()).toHaveLength(2);
    });
  });

  describe('what each kind of item offers', () => {
    it('names the kind and gives it its two buttons', () => {
      show();
      const inbox = t().inbox;
      expect(card(proposal).getByText(inbox.agentProposed)).toBeInTheDocument();
      expect(buttonNames(proposal)).toEqual([inbox.accept, inbox.ignore]);
      expect(card(confirmation).getByText(inbox.agentConfirmation)).toBeInTheDocument();
      expect(buttonNames(confirmation)).toEqual([inbox.viewResult, inbox.cancelTask]);
      expect(card(result).getByText(inbox.agentResult)).toBeInTheDocument();
      expect(buttonNames(result)).toEqual([inbox.viewResult, inbox.close]);
      expect(card(failure).getByText(inbox.agentError)).toBeInTheDocument();
      expect(buttonNames(failure)).toEqual([inbox.retry, inbox.close]);
    });

    it('gives a handled item no button, and says how it was handled', () => {
      show();
      fireEvent.click(tab(t().inboxTabs.all));
      expect(buttonNames(accepted)).toEqual([]);
      expect(card(accepted).getByText(t().inboxTabs.statusAccepted)).toBeInTheDocument();
      expect(buttonNames(ignored)).toEqual([]);
      expect(card(ignored).getByText(t().inboxTabs.statusIgnored)).toBeInTheDocument();
    });
  });

  describe('answering', () => {
    it('adds the proposed todo first, then accepts the item', () => {
      show();
      calls.length = 0;
      press(proposal, t().inbox.accept);
      expect(calls).toEqual([
        ['createTodo', { title: 'Book the venue', source: 'agent_proposed', assignee: 'human', sourceConversationId: 'conv-1' }],
        ['accept', 'proposal'],
      ]);
      // It has left the pending tab and is kept under All.
      expect(shownSummaries()).not.toContain(proposal.summary);
      fireEvent.click(tab(t().inboxTabs.all));
      expect(card(proposal).getByText(t().inboxTabs.statusAccepted)).toBeInTheDocument();
    });

    it('accepts a proposal that carries no title without adding a todo', () => {
      seed([{ ...proposal, payload: {} }]);
      show();
      calls.length = 0;
      press(proposal, t().inbox.accept);
      expect(calls).toEqual([['accept', 'proposal']]);
    });

    it('ignores the item the second button belongs to', () => {
      show();
      calls.length = 0;
      press(proposal, t().inbox.ignore);
      press(confirmation, t().inbox.cancelTask);
      press(result, t().inbox.close);
      press(failure, t().inbox.close);
      expect(calls).toEqual([['ignore', 'proposal'], ['ignore', 'confirmation'], ['ignore', 'result'], ['ignore', 'failure']]);
      expect(screen.getByText(t().inbox.empty)).toBeInTheDocument();
    });

    it('marks the item read from the first button of the other three kinds, and leaves it pending', () => {
      show();
      calls.length = 0;
      press(confirmation, t().inbox.viewResult);
      press(result, t().inbox.viewResult);
      press(failure, t().inbox.retry);
      expect(calls).toEqual([['markRead', 'confirmation'], ['markRead', 'result'], ['markRead', 'failure']]);
      expect(shownSummaries()).toHaveLength(4);
    });
  });

  it('shows an item that arrives while the inbox is open', () => {
    seed([]);
    show();
    act(() => seed([item('arrival', 'agent_result', 70)]));
    expect(shownSummaries()).toEqual(['Summary of arrival']);
  });

  describe('on the design system', () => {
    it('says which tab is in view', () => {
      show();
      expect(tab(t().inboxTabs.pending)).toHaveAttribute('aria-pressed', 'true');
      expect(tab(t().inboxTabs.all)).toHaveAttribute('aria-pressed', 'false');
      fireEvent.click(tab(t().inboxTabs.all));
      expect(tab(t().inboxTabs.pending)).toHaveAttribute('aria-pressed', 'false');
      expect(tab(t().inboxTabs.all)).toHaveAttribute('aria-pressed', 'true');
      expect(tab(t().inboxTabs.all)).toHaveClass('bg-fill-selected');
    });

    it('shows the empty inbox as an empty state with the inbox icon', () => {
      seed([]);
      show();
      const words = screen.getByText(t().inbox.empty);
      expect(words).toHaveClass('text-title');
      expect(words.previousElementSibling?.tagName.toLowerCase()).toBe('svg');
    });

    it('puts an icon beside the name of each kind', () => {
      show();
      const inbox = t().inbox;
      const icon = (entry: InboxItem, label: string) => card(entry).getByText(label).previousElementSibling;
      expect(icon(proposal, inbox.agentProposed)?.tagName.toLowerCase()).toBe('svg');
      expect(icon(proposal, inbox.agentProposed)).toHaveClass('text-label-secondary');
      expect(icon(confirmation, inbox.agentConfirmation)).toHaveClass('text-warning');
      expect(icon(result, inbox.agentResult)).toHaveClass('text-success');
      expect(icon(failure, inbox.agentError)).toHaveClass('text-danger');
    });

    it('marks an unread item with a named sign, and a read one with none', () => {
      seed([result]);
      show();
      // Everything was marked read on the way in.
      expect(screen.queryByRole('img', { name: t().inboxTabs.pending })).toBeNull();
      const arrival = item('arrival', 'agent_result', 70);
      act(() => seed([...Object.values(useInboxStore.getState().items), arrival]));
      expect(card(arrival).getByRole('img', { name: t().inboxTabs.pending })).toHaveClass('text-info');
      expect(card(result).queryByRole('img')).toBeNull();
    });

    it('shows how an item was handled as a tag', () => {
      show();
      fireEvent.click(tab(t().inboxTabs.all));
      expect(card(accepted).getByText(t().inboxTabs.statusAccepted)).toHaveClass('bg-success-soft');
      expect(card(ignored).getByText(t().inboxTabs.statusIgnored)).toHaveClass('bg-fill');
    });

    it('has no filled button: the first of a card is the quiet grey one, the second is plain', () => {
      show();
      const [first, second] = card(proposal).getAllByRole('button');
      expect(first).toHaveClass('bg-fill');
      expect(second).not.toHaveClass('bg-fill');
      expect(document.querySelector('.bg-emphasis')).toBeNull();
    });

    describe('keyboard focus when an answered item leaves', () => {
      const answer = (entry: InboxItem, name: string) => {
        const button = card(entry).getByRole('button', { name });
        button.focus();
        fireEvent.keyDown(button, { key: 'Enter' });
        fireEvent.click(button);
      };

      it('goes to the item that took its place', () => {
        show();
        answer(confirmation, t().inbox.cancelTask);
        expect(card(result).getByRole('button', { name: t().inbox.viewResult })).toHaveFocus();
      });

      it('goes to the item before it when it was the last', () => {
        show();
        answer(failure, t().inbox.close);
        expect(card(result).getByRole('button', { name: t().inbox.viewResult })).toHaveFocus();
      });

      it('goes to the tab in view when no item is left', () => {
        seed([proposal]);
        show();
        answer(proposal, t().inbox.accept);
        expect(tab(t().inboxTabs.pending)).toHaveFocus();
      });

      it('goes to the next item that still has buttons when the item stays, under All', () => {
        show();
        fireEvent.click(tab(t().inboxTabs.all));
        answer(proposal, t().inbox.ignore);
        expect(card(confirmation).getByRole('button', { name: t().inbox.viewResult })).toHaveFocus();
      });

      it('stays where it is when the button remains', () => {
        show();
        answer(result, t().inbox.viewResult);
        expect(card(result).getByRole('button', { name: t().inbox.viewResult })).toHaveFocus();
      });
    });

    describe('render count', () => {
      // Stands in for App, which reads the chat store and renders for every piece of a streamed reply.
      const app = { renders: 0 };
      function AppAround() {
        useChatStore((s) => s.conversations);
        app.renders += 1;
        return <InboxView />;
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

      it('does not draw again when the chat store changes and the app around it renders', () => {
        app.renders = 0;
        render(<DesignSystemProvider><AppAround /></DesignSystemProvider>);
        const before = drawn.items;
        const around = app.renders;
        expect(before).toBeGreaterThan(0);

        for (const text of ['Once', 'Once upon', 'Once upon a time']) act(() => streamPiece(text));

        expect(app.renders).toBe(around + 3);
        expect(drawn.items).toBe(before);
      });

      it('draws again for what it shows: an item that arrives', () => {
        show();
        const before = drawn.items;
        act(() => seed([...ALL, item('arrival', 'agent_result', 70)]));
        expect(drawn.items).toBeGreaterThan(before);
      });
    });
  });
});
