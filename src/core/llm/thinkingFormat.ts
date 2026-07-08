import type { DeclaredCapabilities } from '@/types/provider';

/**
 * Derive the thinking/reasoning format a provider expects in the request body.
 *
 * Priority:
 *  1. Explicit `caps.thinkingFormat` — always wins (user override).
 *  2. Host-pattern matching (case-insensitive).
 *  3. Default: `'openai'` (no translation needed).
 *
 * The `modelId` parameter is reserved for future model-based overrides and is
 * intentionally unused here. The void expression below satisfies `noUnusedParameters`
 * (the same pattern used elsewhere in src/core/llm/ for forward-compat params).
 */
export function deriveThinkingFormat(
  host: string,
  modelId: string,
  caps?: DeclaredCapabilities,
): NonNullable<DeclaredCapabilities['thinkingFormat']> {
  void modelId; // reserved for future model-based overrides

  if (caps?.thinkingFormat) return caps.thinkingFormat;

  const h = host.toLowerCase();

  if (/deepseek\.com/.test(h)) return 'deepseek';
  if (/(^|\.)z\.ai/.test(h)) return 'zai';
  if (/together\.(ai|xyz)/.test(h)) return 'together';
  if (/openrouter\.ai/.test(h)) return 'openrouter';
  if (/dashscope|aliyun|qwen/.test(h)) return 'qwen';

  return 'openai';
}
