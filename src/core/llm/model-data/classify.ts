import type { ThinkingProtocol, ToolResultImageSupport } from '../modelCapabilities';

export function classifyThinking(m: { id: string; family?: string; reasoning: boolean }): ThinkingProtocol {
  if (!m.reasoning) return false;
  const id = m.id.toLowerCase();
  const fam = (m.family ?? '').toLowerCase();
  if (fam.includes('claude') || id.includes('claude')) return 'anthropic';
  if (/^o[34]/.test(id) || /gpt-?5/.test(id) || fam.includes('gpt')) return 'openai-reasoning';
  if (/qwen3\.?\d*-max/.test(id) || (fam.includes('qwen') && /-max/.test(id))) return 'qwen';
  if (/deepseek.*(r1|reasoner)/.test(id)) return 'uncontrollable';
  return 'uncontrollable';
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
