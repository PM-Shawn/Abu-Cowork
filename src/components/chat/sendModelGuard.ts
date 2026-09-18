import { useSettingsStore, getActiveApiKey, providerRequiresApiKey } from '@/stores/settingsStore';
import { useToastStore } from '@/stores/toastStore';
import { getModelUnavailableReason, hasAnyEnabledProvider, getModelDisplayLabel } from '@/utils/settingsSelectors';
import { describeManagedModelRevoked, describeModelUnavailable } from '@/utils/modelUnavailableCopy';
import { requestModelPicker } from './modelPickerRequest';
import type { TranslationDict } from '@/i18n/types';
import type { Conversation } from '@/types';

/**
 * Pre-send check for the model a conversation will run on (its pin, else the
 * global default). Returns true when sending may proceed. When it returns false
 * it has already told the user: a toast naming the unusable model when another
 * provider is usable, otherwise it opens Settings → AI services (unchanged
 * "configure a key" path).
 */
export function ensureConversationModelUsable(
  conversation: Pick<Conversation, 'model'> | undefined,
  chat: TranslationDict['chat'],
): boolean {
  const currentState = useSettingsStore.getState();
  const effModel = conversation?.model ?? currentState.activeModel;
  const effState = { ...currentState, activeModel: effModel };
  const modelIssue = getModelUnavailableReason(currentState, effModel);
  if (modelIssue && hasAnyEnabledProvider(currentState)) {
    const label = getModelDisplayLabel(currentState, effModel);
    const provider = currentState.providers.find((p) => p.id === effModel.providerId);
    if (modelIssue === 'model-removed' && provider?.source === 'managed') {
      // The organization withdrew this model: say so and put the picker in
      // front of the user, since the next pick is the only way forward.
      useToastStore.getState().addToast({ type: 'error', title: describeManagedModelRevoked(chat, label).toast });
      requestModelPicker();
      return false;
    }
    const copy = describeModelUnavailable(chat, modelIssue, label);
    useToastStore.getState().addToast({ type: 'error', title: copy.toast });
    return false;
  }
  // Ollama / LM Studio need no API key.
  if (modelIssue || (providerRequiresApiKey(effState) && !getActiveApiKey(effState)?.trim())) {
    currentState.openSystemSettings('ai-services');
    return false;
  }
  return true;
}
