import type { Conversation, Message } from '@/types';

/**
 * Show the assistant placeholder while a live turn has accepted the latest
 * user message but has not appended its streaming assistant message yet.
 */
export function shouldShowTypingIndicator(
  status: Conversation['status'] | undefined,
  visibleMessages: Message[],
): boolean {
  return status === 'running' && visibleMessages.at(-1)?.role === 'user';
}
