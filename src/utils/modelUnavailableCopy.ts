import { format } from '@/i18n';
import type { TranslationDict } from '@/i18n/types';
import type { ProviderInstance } from '@/types/provider';
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

/**
 * Toast and error-bubble text for a model its organization no longer grants.
 * The user cannot bring it back, so the text asks for another pick instead of
 * explaining which service dropped it.
 */
export function describeManagedModelRevoked(
  chat: Pick<TranslationDict['chat'], 'managedModelRevokedToast' | 'managedModelRevokedInTask'>,
  model: string,
): { toast: string; inTask: string } {
  return {
    toast: format(chat.managedModelRevokedToast, { model }),
    inTask: format(chat.managedModelRevokedInTask, { model }),
  };
}

/**
 * Error-bubble text for a request that never reached a managed provider. The
 * user cannot fix that provider's endpoint, so the text names who runs it and
 * what they can do instead. Null for every other provider and every other
 * failure: the caller keeps its ordinary error text.
 */
export function describeManagedProviderUnreachable(
  chat: Pick<TranslationDict['chat'], 'managedProviderUnreachableInTask'>,
  provider: Pick<ProviderInstance, 'source' | 'name'> | undefined,
  errorCode: string | undefined,
): string | null {
  if (provider?.source !== 'managed') return null;
  if (errorCode !== 'network_error' && errorCode !== 'network_blocked') return null;
  return format(chat.managedProviderUnreachableInTask, { org: provider.name });
}
