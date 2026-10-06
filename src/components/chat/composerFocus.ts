import { focusIsOnWindow } from '@/components/toolbox/cardFocus';

// Puts the focus in the message field of the chat page, for a page change that would otherwise
// leave it on the window. Says whether a field took it.
export function focusComposer(): boolean {
  const field = document.querySelector<HTMLTextAreaElement>('textarea[data-chat-composer]:not(:disabled)');
  if (!field) return false;
  field.focus();
  return document.activeElement === field;
}

// For an action that replaces the page in view with the chat page (start a conversation with an
// expert, view the conversation of a run). The control that was pressed leaves with its page, so
// on the next frame, once the chat page is drawn, the message field takes the focus. It takes it
// from nobody: a control that has the focus keeps it, and so does a window, a question or an
// approval that is on the page, fading out included.
export function focusComposerAfterPageChange(): void {
  requestAnimationFrame(() => {
    if (document.querySelector('[data-ds-layer]:not([hidden])')) return;
    if (focusIsOnWindow()) focusComposer();
  });
}
