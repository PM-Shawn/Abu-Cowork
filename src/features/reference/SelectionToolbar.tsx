// src/features/reference/SelectionToolbar.tsx
import { useState, useEffect, useCallback } from 'react';
import { MessageSquarePlus, MessageSquare } from 'lucide-react';
import { useI18n } from '@/i18n';
import { isMacOS } from '@/utils/platform';
import { CommentEditor } from './CommentEditor';

interface Props {
  rect: DOMRect;
  onAdd: () => void;
  onComment: (comment: string) => void;
  onDismiss: () => void;
}

export function SelectionToolbar({ rect, onAdd, onComment, onDismiss }: Props) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);

  // Keyboard: ⌘/Ctrl+J → open comment editor; Enter → add (only when not in editor)
  useEffect(() => {
    if (editing) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'j' || e.key === 'J')) {
        e.preventDefault();
        setEditing(true);
      } else if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        onAdd();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [editing, onAdd]);

  const style: React.CSSProperties = {
    position: 'fixed',
    left: Math.min(rect.right, window.innerWidth - 300),
    top: rect.bottom + 6,
    zIndex: 50,
  };

  const mod = isMacOS() ? '⌘' : 'Ctrl';

  const handleComment = useCallback((v: string) => { onComment(v); }, [onComment]);

  return (
    <div style={style} role="toolbar" aria-label={t.reference.addToChat} onMouseDown={(e) => e.preventDefault()}>
      {editing ? (
        <CommentEditor onSubmit={handleComment} onCancel={() => { setEditing(false); onDismiss(); }} />
      ) : (
        <div className="flex items-center gap-0.5 rounded-xl border border-[var(--abu-border-subtle)] bg-[var(--abu-bg-elevated)] p-0.5 shadow-lg">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)]"
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
            {t.reference.commentToChat}
            <span className="text-[11px] text-[var(--abu-text-tertiary)]">{mod} J</span>
          </button>
          <div className="h-4 w-px bg-[var(--abu-border-subtle)]" />
          <button
            type="button"
            onClick={onAdd}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)]"
          >
            <MessageSquare className="h-3.5 w-3.5" />
            {t.reference.addToChat}
            <span className="text-[11px] text-[var(--abu-text-tertiary)]">↵</span>
          </button>
        </div>
      )}
    </div>
  );
}
