import type { SettingsState } from '../../stores/settingsStore';
import { getConversationReader } from './ports/conversationReader';

/**
 * The settings a call made on behalf of a conversation should see: the
 * conversation's own model when it has one (its record, else its index
 * entry), otherwise the new-conversation default. Provider identity — adapter,
 * base URL, API key — is derived from this one pair by every caller, so a
 * background call for a conversation (memory extraction, command review,
 * skill evaluation) reaches the same provider with the same credential as the
 * conversation itself, never the default provider's.
 */
export function settingsForConversation(
  conversationId: string,
  settings: SettingsState,
): SettingsState {
  const reader = getConversationReader();
  const model =
    reader.getConversation(conversationId)?.model ??
    reader.getIndexEntry(conversationId)?.model ??
    settings.activeModel;
  return model === settings.activeModel ? settings : { ...settings, activeModel: model };
}
