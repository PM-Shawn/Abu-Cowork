// src/features/reference/SelectionToolbar.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SelectionToolbar } from './SelectionToolbar';

// Mock i18n to get deterministic strings regardless of the test locale.
// Follows the pattern in src/components/chat/QueuedMessagesStrip.test.tsx.
vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      reference: {
        commentToChat: '评论到对话',
        addToChat: '添加到对话',
        commentPlaceholder: '输入你的评论…',
        limitWarning: '{count}',
        quoteChipFallback: '引用',
        maxReached: '最多添加 {max} 条引用',
      },
    },
    format: (s: string) => s,
  }),
}));

const rect = { left: 100, top: 100, right: 200, bottom: 120, width: 100, height: 20 } as DOMRect;

describe('SelectionToolbar', () => {
  it('renders both action buttons; add fires callback; comment opens editor', () => {
    // Plan test 1 checks both buttons render and their callbacks.
    // Note: clicking "评论到对话" opens the CommentEditor (not a direct onComment call) —
    // the direct onComment callback fires only after submitting via Enter in the editor.
    // Here we verify onAdd fires and the editor appears on comment-click.
    const onAdd = vi.fn();
    const onComment = vi.fn();
    render(<SelectionToolbar rect={rect} onAdd={onAdd} onComment={onComment} onDismiss={() => {}} />);
    fireEvent.click(screen.getByText('添加到对话'));
    expect(onAdd).toHaveBeenCalled();
    // Clicking "评论到对话" should switch to the editor (not immediately call onComment)
    fireEvent.click(screen.getByText('评论到对话'));
    expect(screen.getByPlaceholderText('输入你的评论…')).toBeInTheDocument();
    expect(onComment).not.toHaveBeenCalled();
  });

  it('switches to comment editor and submits on Enter', () => {
    const onComment = vi.fn();
    render(<SelectionToolbar rect={rect} onAdd={() => {}} onComment={onComment} onDismiss={() => {}} />);
    fireEvent.click(screen.getByText('评论到对话'));
    const ta = screen.getByPlaceholderText('输入你的评论…') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '优化这段' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onComment).toHaveBeenCalledWith('优化这段');
  });

  it('does not submit empty comment', () => {
    const onComment = vi.fn();
    render(<SelectionToolbar rect={rect} onAdd={() => {}} onComment={onComment} onDismiss={() => {}} />);
    fireEvent.click(screen.getByText('评论到对话'));
    const ta = screen.getByPlaceholderText('输入你的评论…');
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onComment).not.toHaveBeenCalled();
  });
});
