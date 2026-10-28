import type { ChatStore } from '@/stores/chatStore';
import type { ModelRef } from '@/utils/settingsSelectors';

/** An explicit task id owns its model even while another conversation is open. */
export function resolveConversationModel(
  chat: Pick<ChatStore, 'activeConversationId' | 'conversations' | 'conversationIndex'>,
  defaultModel: ModelRef,
  conversationId: string | null = chat.activeConversationId,
): ModelRef {
  return (conversationId
    ? chat.conversations[conversationId]?.model ?? chat.conversationIndex[conversationId]?.model
    : undefined) ?? defaultModel;
}
