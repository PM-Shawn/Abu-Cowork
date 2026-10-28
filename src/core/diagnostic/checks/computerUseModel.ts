import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { resolveConversationModel } from '@/utils/conversationModel';
import { resolveAgentModelCapabilities } from '@/core/llm/modelCapabilities';
import { resolveModelDeclared } from '@/core/llm/resolveModelDeclared';
import { getI18n } from '@/i18n';
import type { CheckResult } from '../types';

export const COMPUTER_USE_MODEL_CHECK_ID = 'ai-services:computer-use-model';

/** Local capability information follows the conversation currently being inspected. */
export function getComputerUseModelCheck(): CheckResult | undefined {
  const settings = useSettingsStore.getState();
  if (!settings.computerUseEnabled) return undefined;
  const model = resolveConversationModel(useChatStore.getState(), settings.activeModel);
  const provider = settings.providers.find((item) => item.id === model.providerId && item.enabled);
  if (!provider || !model.modelId) return undefined;
  const t = getI18n();
  const tier = resolveAgentModelCapabilities({
    modelId: model.modelId,
    providerSource: provider.source,
    declared: resolveModelDeclared(provider, model.modelId),
  }).computerUseTier;
  return {
    id: COMPUTER_USE_MODEL_CHECK_ID,
    category: 'ai-services',
    name: t.diagnostic.aiComputerUseModel,
    status: tier === 'full' ? 'passed' : tier === 'structured' ? 'warning' : 'failed',
    metric: `${model.modelId} · ${tier === 'full'
      ? t.diagnostic.aiComputerUseFull
      : tier === 'structured'
        ? t.diagnostic.aiComputerUseStructured
        : tier === 'unsupported'
          ? t.diagnostic.aiComputerUseUnsupported
          : t.diagnostic.aiComputerUseUnknown}`,
    ...(tier === 'unsupported' ? {
      errorMessage: t.diagnostic.aiComputerUseToolsMissing,
    } : tier === 'unknown' ? {
      errorMessage: t.diagnostic.aiComputerUseUnknownReason,
    } : tier === 'structured' ? {
      errorMessage: t.diagnostic.aiComputerUseVisionMissing,
    } : {}),
    suggestedAction: tier !== 'full' ? {
      type: 'open-settings',
      target: 'ai-services',
      label: t.diagnostic.actionOpenAIServices,
    } : undefined,
    checkedAt: Date.now(),
    durationMs: 0,
    freshness: 'fresh',
  };
}
