import { focusIsOnWindow } from '@/components/toolbox/cardFocus';

// Puts the focus in the message field of the chat page, for a page change that would otherwise
// leave it on the window. Says whether a field took it.
export function focusComposer(): boolean {
  const field = document.querySelector<HTMLTextAreaElement>('textarea[data-chat-composer]:not(:disabled)');
  if (!field) return false;
  field.focus();
  return document.activeElement === field;
}

// The message field takes the focus when nobody has it: a control that has the focus keeps it,
// and so does a window, a question or an approval that is on the page, fading out included.
// The field is the only target: Send and Stop never take the focus by code, and the field sends
// once per press of Enter, so a key still down from the control that left starts nothing.
export function focusComposerFromWindow(): void {
  if (document.querySelector('[data-ds-layer]:not([hidden])')) return;
  if (focusIsOnWindow()) focusComposer();
}

// For an action that replaces the page in view with the chat page (start a conversation with an
// expert, view the conversation of a run, the first message of a new task). The control that was
// pressed leaves with its page, so on the next frame, once the chat page is drawn, the message
// field takes the focus, from nobody (`focusComposerFromWindow`).
export function focusComposerAfterPageChange(): void {
  requestAnimationFrame(focusComposerFromWindow);
}
