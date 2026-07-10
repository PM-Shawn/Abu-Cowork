import type { LLMProvider, ApiFormat } from '@/types';
import type { ModelDeclaredCapabilities } from '@/types/provider';

/** Whether the "advanced config" (declared capabilities) section should show.
 *  Any custom provider (openai-compatible OR anthropic format), or local
 *  Ollama / LM Studio. Builtin cloud providers → false.
 *  Anthropic-format custom endpoints are often proxies fronting non-Claude
 *  models, so tools/vision/token-limit declarations are still meaningful;
 *  the fields that don't apply (useRawUrl, reasoning-effort) are hidden by
 *  AdvancedCapabilitiesFields based on apiFormat. */
export function computeShowAdvanced(
  isCustom: boolean,
  provider: LLMProvider | undefined,
  apiFormat: ApiFormat | undefined,
): boolean {
  return (isCustom && (apiFormat === 'openai-compatible' || apiFormat === 'anthropic'))
    || provider === 'ollama' || provider === 'lmstudio';
}

/** Toggle one effort level in the supportedEfforts array (order-preserving add/remove). */
export function toggleEffort(
  current: Array<'low' | 'medium' | 'high'> | undefined,
  effort: 'low' | 'medium' | 'high',
): Array<'low' | 'medium' | 'high'> {
  const set = new Set(current ?? []);
  if (set.has(effort)) set.delete(effort); else set.add(effort);
  return [...set];
}

/** Defaults for a newly added custom model (per-model). Tools on, images/reasoning off.
 *  Intentionally omits `useRawUrl` — that's an endpoint-level setting, tracked in a
 *  sibling `useRawUrl` state, not part of per-model declared capabilities. */
export function defaultModelDeclaredCapabilities(): ModelDeclaredCapabilities {
  return { supportsTools: true, supportsImages: false, supportsReasoning: false };
}
