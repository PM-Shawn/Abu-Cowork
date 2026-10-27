import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { resolveConversationModel } from '@/utils/conversationModel';

/** Omit the id for the open conversation; null addresses the new-task page. */
export function useConversationModel(conversationId?: string | null) {
  const defaultModel = useSettingsStore((state) => state.activeModel);
  return useChatStore((state) => resolveConversationModel(state, defaultModel, conversationId));
}
