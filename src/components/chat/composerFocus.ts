// Puts the focus in the message field of the chat page, for a page change that would otherwise
// leave it on the window. Says whether a field took it.
export function focusComposer(): boolean {
  const field = document.querySelector<HTMLTextAreaElement>('textarea[data-chat-composer]:not(:disabled)');
  if (!field) return false;
  field.focus();
  return document.activeElement === field;
}
