import type { DeclaredCapabilities, ProviderInstance } from '@/types/provider';

/**
 * Resolve the effective DeclaredCapabilities for one model on a provider.
 * - Model-varying fields (tools/images/reasoning/efforts/maxInput/maxOutput): the model's
 *   own override wins; falls back to the provider-level value (legacy / shared default).
 * - Endpoint/protocol-level fields (useRawUrl/thinkingFormat/maxTokensField/
 *   requiresToolResultName): always taken from the provider.
 * Returns undefined only when neither model nor provider declares anything, so callers can
 * keep treating a missing result as "auto-detect" exactly like the old provider-level read.
 */
export function resolveModelDeclared(
  provider: ProviderInstance | undefined,
  modelId: string,
): DeclaredCapabilities | undefined {
  if (!provider) return undefined;
  const p = provider.declaredCapabilities;
  const m = provider.models.find((model) => model.id === modelId)?.declaredCapabilities;
  if (!p && !m) return undefined;
  return {
    supportsTools: m?.supportsTools ?? p?.supportsTools,
    supportsImages: m?.supportsImages ?? p?.supportsImages,
    supportsReasoning: m?.supportsReasoning ?? p?.supportsReasoning,
    supportedEfforts: m?.supportedEfforts ?? p?.supportedEfforts,
    maxInputTokens: m?.maxInputTokens ?? p?.maxInputTokens,
    maxOutputTokens: m?.maxOutputTokens ?? p?.maxOutputTokens,
    useRawUrl: p?.useRawUrl,
    thinkingFormat: p?.thinkingFormat,
    maxTokensField: p?.maxTokensField,
    requiresToolResultName: p?.requiresToolResultName,
  };
}
