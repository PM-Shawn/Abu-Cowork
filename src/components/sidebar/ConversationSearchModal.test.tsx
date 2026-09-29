// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import ConversationSearchModal from './ConversationSearchModal';

const mocks = vi.hoisted(() => ({
  chat: {} as Record<string, unknown>,
  catalogSearch: vi.fn(),
}));

vi.mock('@/stores/chatStore', () => {
  const useChatStore = (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.chat);
  useChatStore.getState = () => mocks.chat;
  return { useChatStore };
});
vi.mock('@/core/session/conversationStorage', () => ({ catalogSearch: mocks.catalogSearch }));

const conv = (id: string, title: string, createdAt: number) => ({ id, title, createdAt, updatedAt: createdAt, messageCount: 1 });

function renderSearch(onClose: () => void = vi.fn()) {
  return render(<ConversationSearchModal open onClose={onClose} />, { wrapper: DesignSystemProvider });
}

beforeEach(() => {
  initLanguage('zh-CN');
  mocks.catalogSearch.mockReset();
  mocks.catalogSearch.mockResolvedValue([]);
  mocks.chat = {
    conversationIndex: {
      a: conv('a', 'Quarterly report', 3),
      b: conv('b', 'Travel plan', 2),
      c: conv('c', 'Report draft', 1),
    },
    switchConversation: vi.fn(),
    clearCompletedStatus: vi.fn(),
    setPendingSearchJump: vi.fn(),
  };
});
afterEach(() => cleanup());

describe('ConversationSearchModal', () => {
  it('closes on Escape even before the search input receives focus', () => {
    const onClose = vi.fn();

    renderSearch(onClose);
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('opens as a design-system dialog with the field focused and recent tasks listed', () => {
    renderSearch();
    const dialog = screen.getByRole('dialog', { name: '搜索' });
    expect(dialog).toHaveAttribute('data-ds-layer');
    // 「搜索」 names the dialog for screen readers but is not shown: the field says it.
    expect(within(dialog).getByText('搜索')).not.toHaveClass('text-title');
    expect(within(dialog).getByText('搜索').style.position).toBe('absolute');
    expect(within(dialog).getByPlaceholderText('搜索对话...')).toHaveFocus();
    expect(within(dialog).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Quarterly report', 'Travel plan', 'Report draft',
    ]);
  });

  it('opens the first match with Enter', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderSearch(onClose);
    await user.type(screen.getByPlaceholderText('搜索对话...'), 'report{Enter}');
    expect(mocks.chat.switchConversation).toHaveBeenCalledWith('a');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('moves between the field and the results with the arrow keys, and Enter opens the focused one', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderSearch(onClose);
    const field = screen.getByPlaceholderText('搜索对话...');
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: 'Quarterly report' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: 'Travel plan' })).toHaveFocus();
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(field).toHaveFocus();
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(mocks.chat.switchConversation).toHaveBeenCalledWith('b');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('says so when nothing matches', async () => {
    const user = userEvent.setup();
    renderSearch();
    await user.type(screen.getByPlaceholderText('搜索对话...'), 'zzz');
    expect(screen.getByText('没有匹配的对话')).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).queryByRole('button', { name: /report|plan/i })).toBeNull();
  });

  it('sizes the results to their content and keeps the top edge still while typing', () => {
    renderSearch();
    const dialog = screen.getByRole('dialog');
    const results = within(dialog).getByRole('button', { name: 'Quarterly report' }).parentElement as HTMLElement;
    // A maximum height, then scrolling; never a fixed height that leaves an empty area.
    expect(results).toHaveClass('max-h-80', 'overflow-y-auto');
    expect(results).not.toHaveClass('h-80');
    expect(dialog).toHaveClass('top-1/7');
  });
});
