import type { DeclaredCapabilities } from '@/types/provider';
import type { ModelCapabilities } from './modelCapabilities';

/**
 * Override auto-detected capabilities with user-declared values (custom/local providers only).
 * Returns a new object; never mutates input.
 * - supportsImages → vision
 * - supportsReasoning=false → thinking off; =true on a non-thinking model → 'openai-reasoning'
 * tools/efforts/useRawUrl are NOT applied here — the adapter's rule engine + URL builder handle those.
 */
export function applyDeclaredCapabilities(
  caps: ModelCapabilities,
  declared: DeclaredCapabilities | undefined,
): ModelCapabilities {
  if (!declared) return caps;
  const next = { ...caps };
  if (declared.supportsImages !== undefined) next.vision = declared.supportsImages;
  if (declared.supportsReasoning === false) next.thinking = false;
  else if (declared.supportsReasoning === true && next.thinking === false) next.thinking = 'openai-reasoning';
  return next;
}
