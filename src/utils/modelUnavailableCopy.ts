import { format } from '@/i18n';
import type { TranslationDict } from '@/i18n/types';
import type { ModelUnavailableReason } from './settingsSelectors';

type Keys =
  | 'modelUnavailableLabel' | 'modelUnavailableToast' | 'modelUnavailableInTask'
  | 'modelUnavailableReasonProviderRemoved' | 'modelUnavailableReasonProviderDisabled'
  | 'modelUnavailableReasonModelRemoved';

const REASON_KEY: Record<ModelUnavailableReason, Keys> = {
  'provider-removed': 'modelUnavailableReasonProviderRemoved',
  'provider-disabled': 'modelUnavailableReasonProviderDisabled',
  'model-removed': 'modelUnavailableReasonModelRemoved',
};

/** The three user-facing strings for a conversation whose pinned model can no longer be used. */
export function describeModelUnavailable(
  chat: Pick<TranslationDict['chat'], Keys>,
  reason: ModelUnavailableReason,
  model: string,
): { label: string; toast: string; inTask: string } {
  const values = { model, reason: chat[REASON_KEY[reason]] };
  return {
    label: format(chat.modelUnavailableLabel, { model }),
    toast: format(chat.modelUnavailableToast, values),
    inTask: format(chat.modelUnavailableInTask, values),
  };
}
