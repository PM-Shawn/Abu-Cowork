import type { LLMProvider } from '@/types';

/** Whether the "advanced config" (declared capabilities) section should show:
 *  custom providers, or local Ollama / LM Studio. Builtin cloud providers → false. */
export function computeShowAdvanced(isCustom: boolean, provider: LLMProvider | undefined): boolean {
  return isCustom || provider === 'ollama' || provider === 'lmstudio';
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
