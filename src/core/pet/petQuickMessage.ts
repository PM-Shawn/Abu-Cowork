import { createGeneralShellConversation } from '@/core/app/generalShellConversation';
import { useChatStore } from '@/stores/chatStore';

/**
 * The conversation a message typed into the pet goes to.
 *
 * A reply to a notice goes to the conversation the notice pointed at, when it
 * is loaded; any other message goes to the conversation open in the main
 * window, whichever app that conversation belongs to. With no conversation
 * open the message starts one. The pet is an entry of its own, used without
 * looking at the main window, so that conversation belongs to the general
 * shell (`createGeneralShellConversation`).
 */
export function petMessageConversation(conversationId: string | null | undefined, { leaveApp }: { leaveApp: boolean }): string {
  const chat = useChatStore.getState();
  if (conversationId && chat.conversations[conversationId]) return conversationId;
  return chat.activeConversationId ?? createGeneralShellConversation(null, { leaveApp });
}
