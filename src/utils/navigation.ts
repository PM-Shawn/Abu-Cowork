import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';

/**
 * Start a new conversation, switch to chat view, and pre-fill the input.
 * Used by editors and schedule view to navigate the user into a fresh chat.
 */
export function navigateToChatWithInput(pendingInput: string): void {
  useChatStore.getState().startNewConversation();
  useSettingsStore.getState().setViewMode('chat');
  useChatStore.getState().setPendingInput(pendingInput, { startsTask: true });
}
