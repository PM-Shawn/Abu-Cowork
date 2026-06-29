import type { ThinkingProtocol, ToolResultImageSupport } from '../modelCapabilities';

/**
 * Single source of truth for the reasoning→protocol mapping, keyed purely on
 * id/family patterns. Assumes the model reasons — callers gate on a reasoning
 * signal first (the snapshot `reasoning` flag in classifyThinking, or the matched
 * family branch in modelCapabilities.resolveCapabilities). Returns a non-false
 * protocol (defaults to 'uncontrollable': reasons, but exposes no budget knob).
 *
 * Both the build-time classifier and the runtime pattern fallback call this so the
 * protocol *label* for a given family stays identical inside the snapshot and in the
 * runtime fallback. (Membership — which ids are treated as reasoning at all — is still
 * decided by each caller: classifyThinking gates on the snapshot `reasoning` flag,
 * resolveCapabilities on its own family branches.)
 */
export function classifyThinkingProtocol(
  id: string,
  family?: string,
): Exclude<ThinkingProtocol, false> {
  const lid = id.toLowerCase();
  const fam = (family ?? '').toLowerCase();
  if (fam.includes('claude') || lid.includes('claude')) return 'anthropic';
  if (/^o[1-9]/.test(lid) || /gpt-?5/.test(lid) || fam.includes('gpt')) return 'openai-reasoning';
  if (/qwen3\.?\d*-max/.test(lid) || (fam.includes('qwen') && /-max/.test(lid))) return 'qwen';
  // DeepSeek R1 and any other reasoning model with no controllable budget knob.
  return 'uncontrollable';
}

export function classifyThinking(m: { id: string; family?: string; reasoning: boolean }): ThinkingProtocol {
  if (!m.reasoning) return false;
  return classifyThinkingProtocol(m.id, m.family);
}

export function classifyToolResultImages(id: string, family?: string): ToolResultImageSupport {
  const s = `${family ?? ''} ${id}`.toLowerCase();
  if (s.includes('claude')) return 'native';
  if (/llama|gemma|mistral|codellama|phi\d|deepseek|moonshot|kimi/.test(s)) return 'none';
  return 'workaround';
}

export function classifyDocumentBlock(id: string, family?: string): boolean {
  return `${family ?? ''} ${id}`.toLowerCase().includes('claude');
}
