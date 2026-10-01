// src/features/reference/SelectionToolbar.tsx
import { useEffect, useCallback } from 'react';
import { Button } from '@/components/ds/button';
import { AppIcons } from '@/components/ds/icons';
import { Kbd } from '@/components/ds/kbd';
import { useI18n } from '@/i18n';
import { isMacOS } from '@/utils/platform';
import { CommentEditor } from './CommentEditor';
import { computeToolbarPosition } from './toolbarPosition';

interface Props {
  rect: DOMRect;
  /** Controlled: whether the comment editor is open. Owned by the host so it can
   *  pause selection tracking synchronously before the editor steals focus. */
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  onAdd: () => void;
  onComment: (comment: string) => void;
  onDismiss: () => void;
  /** Document-level ⌘J/Enter shortcuts. Hosts where those keys are live input
   *  (the terminal: Enter runs the shell command) must opt out — otherwise the
   *  toolbar would hijack a keystroke the user aimed at the host. */
  enableKeyboard?: boolean;
}

export function SelectionToolbar({ rect, editing, onEditingChange, onAdd, onComment, onDismiss, enableKeyboard = true }: Props) {
  const { t } = useI18n();

  // Keyboard: ⌘/Ctrl+J → open comment editor; Enter → add (only when not in editor)
  useEffect(() => {
    if (editing || !enableKeyboard) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'j' || e.key === 'J')) {
        e.preventDefault();
        onEditingChange(true);
      } else if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        onAdd();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [editing, enableKeyboard, onAdd, onEditingChange]);

  // Estimated size of the toolbar buttons row; used for edge-clamping without
  // a ResizeObserver (acceptable V1 approximation — real size is within ~10 px).
  const TOOLBAR_SIZE = { width: 300, height: 44 };
  const { left, top } = computeToolbarPosition(
    rect,
    { width: window.innerWidth, height: window.innerHeight },
    TOOLBAR_SIZE,
  );

  const mod = isMacOS() ? '⌘' : 'Ctrl';

  const handleComment = useCallback((v: string) => { onComment(v); }, [onComment]);

  return (
    <div
      className="fixed z-popover"
      style={{ left, top }}
      role="toolbar"
      data-selection-toolbar
      data-electron-no-drag
      aria-label={t.reference.addToChat}
      onMouseDown={(e) => e.preventDefault()}
    >
      {editing ? (
        <CommentEditor onSubmit={handleComment} onCancel={() => { onEditingChange(false); onDismiss(); }} />
      ) : (
        <div className="flex items-center gap-1 rounded-panel bg-raised p-1 shadow-float">
          <Button variant="plain" size="sm" icon={AppIcons.commentToChat} onClick={() => onEditingChange(true)}>
            {t.reference.commentToChat}
            {enableKeyboard && <Kbd>{mod} J</Kbd>}
          </Button>
          <div className="h-4 w-px bg-separator" />
          <Button variant="plain" size="sm" icon={AppIcons.quoteToChat} onClick={onAdd}>
            {t.reference.addToChat}
            {enableKeyboard && <Kbd>↵</Kbd>}
          </Button>
        </div>
      )}
    </div>
  );
}
