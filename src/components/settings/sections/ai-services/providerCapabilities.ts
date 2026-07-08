import type { LLMProvider, ApiFormat } from '@/types';
import type { DeclaredCapabilities } from '@/types/provider';

/** Whether the "advanced config" (declared capabilities) section should show.
 *  Only custom providers using openai-compatible format, or local Ollama / LM Studio.
 *  Builtin cloud providers and anthropic-format custom providers → false. */
export function computeShowAdvanced(
  isCustom: boolean,
  provider: LLMProvider | undefined,
  apiFormat: ApiFormat | undefined,
): boolean {
  return (isCustom && apiFormat === 'openai-compatible')
    || provider === 'ollama' || provider === 'lmstudio';
}

/** Defaults for a newly added custom/local provider so capability toggles are explicit
 *  (not misleading undefined tri-state). Tools on, images/reasoning off — user adjusts. */
export function defaultDeclaredCapabilities(): DeclaredCapabilities {
  return { supportsTools: true, supportsImages: false, supportsReasoning: false };
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
