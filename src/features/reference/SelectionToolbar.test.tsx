// src/features/reference/SelectionToolbar.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
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
        quoteChipFallback: '引用',
        maxReached: '最多添加 {max} 条引用',
      },
    },
    format: (s: string) => s,
  }),
}));

const rect = { left: 100, top: 100, right: 200, bottom: 120, width: 100, height: 20 } as DOMRect;

/** SelectionToolbar is controlled (editing owned by the host); this harness
 *  supplies that state so clicking "评论到对话" flips editing → shows the editor. */
function Harness({ onAdd, onComment, onDismiss }: {
  onAdd?: () => void;
  onComment?: (v: string) => void;
  onDismiss?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <SelectionToolbar
      rect={rect}
      editing={editing}
      onEditingChange={setEditing}
      onAdd={onAdd ?? (() => {})}
      onComment={onComment ?? (() => {})}
      onDismiss={onDismiss ?? (() => {})}
    />
  );
}

describe('SelectionToolbar', () => {
  it('renders both action buttons; add fires callback; comment opens editor', () => {
    const onAdd = vi.fn();
    const onComment = vi.fn();
    render(<Harness onAdd={onAdd} onComment={onComment} />);
    fireEvent.click(screen.getByText('添加到对话'));
    expect(onAdd).toHaveBeenCalled();
    // Clicking "评论到对话" should switch to the editor (not immediately call onComment)
    fireEvent.click(screen.getByText('评论到对话'));
    expect(screen.getByPlaceholderText('输入你的评论…')).toBeInTheDocument();
    expect(onComment).not.toHaveBeenCalled();
  });

  it('switches to comment editor and submits on Enter', () => {
    const onComment = vi.fn();
    render(<Harness onComment={onComment} />);
    fireEvent.click(screen.getByText('评论到对话'));
    const ta = screen.getByPlaceholderText('输入你的评论…') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '优化这段' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onComment).toHaveBeenCalledWith('优化这段');
  });

  it('does not submit empty comment', () => {
    const onComment = vi.fn();
    render(<Harness onComment={onComment} />);
    fireEvent.click(screen.getByText('评论到对话'));
    const ta = screen.getByPlaceholderText('输入你的评论…');
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onComment).not.toHaveBeenCalled();
  });
});
