import { useSettingsStore, getActiveApiKey, providerRequiresApiKey } from '@/stores/settingsStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { useToastStore } from '@/stores/toastStore';
import { getModelUnavailableReason, hasAnyEnabledProvider, getModelDisplayLabel } from '@/utils/settingsSelectors';
import { describeModelUnavailable } from '@/utils/modelUnavailableCopy';
import type { TranslationDict } from '@/i18n/types';
import type { Conversation } from '@/types';

/**
 * Pre-send check for the model a conversation will run on (its pin, else the
 * global default). Returns true when sending may proceed. When it returns false
 * it has already told the user: a toast naming the unusable model when another
 * provider is usable, otherwise it opens Settings → AI services (unchanged
 * "configure a key" path). Enterprise mode always returns true.
 */
export function ensureConversationModelUsable(
  conversation: Pick<Conversation, 'model'> | undefined,
  chat: TranslationDict['chat'],
): boolean {
  if (useEnterpriseStore.getState().mode.kind !== 'personal') return true;
  const currentState = useSettingsStore.getState();
  const effModel = conversation?.model ?? currentState.activeModel;
  const effState = { ...currentState, activeModel: effModel };
  const modelIssue = getModelUnavailableReason(currentState, effModel);
  if (modelIssue && hasAnyEnabledProvider(currentState)) {
    const copy = describeModelUnavailable(chat, modelIssue, getModelDisplayLabel(currentState, effModel));
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
