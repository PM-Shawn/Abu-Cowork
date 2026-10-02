// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import ConversationPicker from './ConversationPicker';

// The real checkbox, counted: a conversation row draws one, so the count says which rows were drawn again.
const checkboxRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/components/ds/checkbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/checkbox')>();
  return {
    Checkbox: (props: Parameters<typeof actual.Checkbox>[0]) => {
      checkboxRenders.count += 1;
      return <actual.Checkbox {...props} />;
    },
  };
});

// Made-up conversations: only what the picker reads (title, time, message count).
const NOW = new Date(2026, 9, 2, 12, 0, 0).getTime();
const MINUTE = 60_000;

function conversation(id: string, title: string, minutesAgo: number, messageCount: number) {
  return { id, title, createdAt: NOW - minutesAgo * MINUTE, updatedAt: NOW - minutesAgo * MINUTE, messageCount };
}

const SIX = [
  conversation('c-report', 'Quarterly report', 50, 12),
  conversation('c-alpha', 'Alpha plan', 10, 4),
  conversation('c-untitled', '', 30, 1),
  conversation('c-beta', 'Beta notes', 20, 7),
  conversation('c-gamma', 'Gamma review', 40, 2),
  conversation('c-delta', 'Delta ALPHA follow-up', 60, 9),
];

function fill(list: ReturnType<typeof conversation>[], activeConversationId: string | null = null) {
  useChatStore.setState({
    conversationIndex: Object.fromEntries(list.map((c) => [c.id, c])),
    activeConversationId,
  } as never);
}

const addToast = vi.fn();
const onChange = vi.fn();

// The picker with its selection held by the page around it, as the feedback form holds it.
function Page({ initial = [], disabled = false }: { initial?: string[]; disabled?: boolean }) {
  const [selected, setSelected] = useState(initial);
  return (
    <ConversationPicker
      selectedIds={selected}
      disabled={disabled}
      onChange={(ids) => { onChange(ids); setSelected(ids); }}
    />
  );
}

function renderPicker(props: { initial?: string[]; disabled?: boolean } = {}) {
  return render(<Page {...props} />, { wrapper: DesignSystemProvider });
}

const trigger = () => screen.getByRole('button', { name: /点击选择要附带的对话|已选 \d+ 个/ });

async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(trigger());
  return screen.getByPlaceholderText('搜索对话标题');
}

// The row of one conversation: the list item that holds its title.
function row(title: string): HTMLElement {
  const item = screen.getByText(title).closest('li');
  if (!item) throw new Error(`No row for ${title}`);
  return item;
}

const titles = () => screen.getAllByRole('listitem').map((item) => item.textContent ?? '');

beforeAll(() => {
  // happy-dom lacks the scroll call Radix makes when a layer takes focus.
  Element.prototype.scrollIntoView ??= () => undefined;
});

describe('ConversationPicker', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    addToast.mockReset();
    onChange.mockReset();
    useToastStore.setState({ addToast });
    fill(SIX, 'c-beta');
    checkboxRenders.count = 0;
  });

  afterEach(cleanup);

  describe('what it shows', () => {
    it('asks for a choice while nothing is selected, and counts what is', () => {
      const { unmount } = renderPicker();
      expect(screen.getByRole('button', { name: '点击选择要附带的对话' })).toBeInTheDocument();
      unmount();

      renderPicker({ initial: ['c-alpha', 'c-beta'] });
      expect(screen.getByRole('button', { name: '已选 2 个' })).toBeInTheDocument();
    });

    it('lists conversations newest first, with the message count and the one in view marked', async () => {
      const user = userEvent.setup();
      renderPicker();
      expect(screen.queryByPlaceholderText('搜索对话标题')).not.toBeInTheDocument();

      await openPicker(user);

      const rows = titles();
      expect(rows).toHaveLength(6);
      expect(rows[0]).toContain('Alpha plan');
      expect(rows[1]).toContain('Beta notes');
      expect(rows[2]).toContain('（无标题对话）');
      expect(rows[5]).toContain('Delta ALPHA follow-up');
      expect(within(row('Alpha plan')).getByText('含 4 条消息')).toBeInTheDocument();
      expect(within(row('Beta notes')).getByText('当前')).toBeInTheDocument();
      expect(within(row('Alpha plan')).queryByText('当前')).not.toBeInTheDocument();
    });

    it('narrows the list by title, whatever the letter case', async () => {
      const user = userEvent.setup();
      renderPicker();
      const search = await openPicker(user);

      await user.type(search, 'alpha');
      expect(titles()).toHaveLength(2);
      expect(screen.getByText('Alpha plan')).toBeInTheDocument();
      expect(screen.getByText('Delta ALPHA follow-up')).toBeInTheDocument();

      await user.type(search, ' zzz');
      expect(screen.queryAllByRole('listitem')).toHaveLength(0);
      expect(screen.getByText('没有找到对话')).toBeInTheDocument();
    });

    it('cannot be opened while the form is busy', async () => {
      const user = userEvent.setup();
      renderPicker({ disabled: true });

      expect(trigger()).toBeDisabled();
      await user.click(trigger());
      expect(screen.queryByPlaceholderText('搜索对话标题')).not.toBeInTheDocument();
    });
  });

  describe('choosing', () => {
    it('adds a conversation when its box is ticked, removes it when unticked, and stays open', async () => {
      const user = userEvent.setup();
      renderPicker({ initial: ['c-beta'] });
      await openPicker(user);
      const alpha = () => within(row('Alpha plan')).getByRole('checkbox');
      expect(alpha()).toHaveAttribute('aria-checked', 'false');
      expect(within(row('Beta notes')).getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');

      await user.click(alpha());
      expect(onChange).toHaveBeenLastCalledWith(['c-beta', 'c-alpha']);
      expect(alpha()).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByPlaceholderText('搜索对话标题')).toBeInTheDocument();

      await user.click(alpha());
      expect(onChange).toHaveBeenLastCalledWith(['c-beta']);
      expect(alpha()).toHaveAttribute('aria-checked', 'false');
      expect(onChange).toHaveBeenCalledTimes(2);
    });

    it('ticks a conversation from its title too, once per press', async () => {
      const user = userEvent.setup();
      renderPicker();
      await openPicker(user);

      await user.click(screen.getByText('Gamma review'));

      expect(onChange.mock.calls).toEqual([[['c-gamma']]]);
      expect(within(row('Gamma review')).getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');
    });

    it('takes no sixth conversation and says what the limit is', async () => {
      const user = userEvent.setup();
      const five = ['c-report', 'c-alpha', 'c-untitled', 'c-beta', 'c-gamma'];
      renderPicker({ initial: five });
      await openPicker(user);

      await user.click(within(row('Delta ALPHA follow-up')).getByRole('checkbox'));

      expect(onChange).not.toHaveBeenCalled();
      expect(within(row('Delta ALPHA follow-up')).getByRole('checkbox')).toHaveAttribute('aria-checked', 'false');
      expect(addToast).toHaveBeenCalledExactlyOnceWith({ title: '最多可选 5 个对话', type: 'warning', duration: 3000 });

      // One of the five can still be taken out.
      await user.click(within(row('Alpha plan')).getByRole('checkbox'));
      expect(onChange).toHaveBeenCalledExactlyOnceWith(['c-report', 'c-untitled', 'c-beta', 'c-gamma']);
      expect(addToast).toHaveBeenCalledTimes(1);
    });
  });

  describe('closing', () => {
    it('closes on Escape and keeps what was typed in the search for the next time', async () => {
      const user = userEvent.setup();
      renderPicker();
      const search = await openPicker(user);
      await user.type(search, 'beta');

      await user.keyboard('{Escape}');
      expect(screen.queryByPlaceholderText('搜索对话标题')).not.toBeInTheDocument();

      expect(await openPicker(user)).toHaveValue('beta');
      expect(titles()).toHaveLength(1);
    });
  });

  describe('as a design-system layer', () => {
    it('opens as one floating layer with a named checkbox per conversation', async () => {
      const user = userEvent.setup();
      renderPicker();
      expect(trigger()).toHaveAttribute('aria-expanded', 'false');

      const search = await openPicker(user);

      expect(trigger()).toHaveAttribute('aria-expanded', 'true');
      const layer = search.closest('[data-ds-layer]');
      expect(layer).not.toBeNull();
      expect(document.querySelectorAll('[data-ds-layer]')).toHaveLength(1);
      expect(within(layer as HTMLElement).getAllByRole('checkbox')).toHaveLength(6);
      expect(screen.getByRole('checkbox', { name: 'Alpha plan' })).toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: '（无标题对话）' })).toBeInTheDocument();
    });

    it('draws no row while it is closed', () => {
      renderPicker();

      expect(checkboxRenders.count).toBe(0);
    });

    it('draws only the row that changed when one conversation is ticked', async () => {
      const user = userEvent.setup();
      renderPicker();
      await openPicker(user);
      expect(checkboxRenders.count).toBeGreaterThan(0);

      checkboxRenders.count = 0;
      fireEvent.click(screen.getByRole('checkbox', { name: 'Gamma review' }));

      expect(checkboxRenders.count).toBe(1);
    });

    it('draws no remaining row again while the search narrows the list', async () => {
      const user = userEvent.setup();
      renderPicker();
      const search = await openPicker(user);
      expect(checkboxRenders.count).toBeGreaterThan(0);

      checkboxRenders.count = 0;
      fireEvent.change(search, { target: { value: 'alpha' } });

      expect(screen.getAllByRole('checkbox')).toHaveLength(2);
      expect(checkboxRenders.count).toBe(0);
    });
  });
});
