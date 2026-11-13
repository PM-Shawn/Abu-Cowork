import type { ProviderInstance } from '@/types/provider';
import type { DiscoveredCaps } from '@/stores/discoveredCapabilitiesStore';
import type { SettingsState } from '@/stores/settingsStore';
import { computeReasoningParams, type ModelCapabilities } from './modelCapabilities';
import { positiveInteger, resolveContextWindow } from './contextWindow';
import { resolveModelDeclared } from './resolveModelDeclared';
import { localServerKind } from './localProvider';
import { resolveThinkingPick } from './modelProfile';

/** Resolve the same model limits and paired reasoning/output budgets for every conversation request. */
export function resolveRequestBudget(
  modelId: string,
  modelCaps: ModelCapabilities,
  provider: ProviderInstance | undefined,
  settings: Pick<SettingsState, 'contextWindowSize' | 'maxOutputTokens'>,
  discovered?: DiscoveredCaps,
  probed?: number,
) {
  const declared = resolveModelDeclared(provider, modelId);
  const maxOutputTokens = discovered?.maxOutputTokens ?? modelCaps.maxOutputTokens;
  const effectiveCaps: ModelCapabilities = {
    ...modelCaps,
    maxOutputTokens,
    contextWindow: discovered?.contextWindow ?? modelCaps.contextWindow,
    ...(discovered?.isReasoningModel && modelCaps.thinking === false && declared?.supportsReasoning !== false
      ? { thinking: 'uncontrollable' as const } : {}),
  };
  const window = resolveContextWindow({
    modelId,
    userSetting: declared?.maxInputTokens,
    probed: probed ?? provider?.models.find((model) => model.id === modelId)?.contextWindow,
    discovered: discovered?.contextWindow,
    discoveredProbe: discovered?.contextWindowProbe,
    isLocal: localServerKind(provider) !== null,
    ceiling: settings.contextWindowSize,
  });
  const thinkingPick = resolveThinkingPick({ modelId, provider, declared });
  const requestedMaxOutputTokens = declared?.maxOutputTokens ?? settings.maxOutputTokens ?? maxOutputTokens;
  return {
    effectiveCaps,
    contextWindowSize: window.size,
    reserveWindowSize: window.uncappedSize,
    requestedContextLength: positiveInteger(declared?.maxInputTokens),
    localServer: localServerKind(provider) !== null,
    outputCeiling: discovered?.maxOutputTokens ?? modelCaps.outputCeiling ?? modelCaps.maxOutputTokens,
    requestedMaxOutputTokens,
    thinkingPick,
    reasoningParams: computeReasoningParams(effectiveCaps, requestedMaxOutputTokens, window.uncappedSize, thinkingPick),
  };
}
