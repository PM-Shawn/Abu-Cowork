/**
 * The user's per-model thinking effort (设置 → 思考强度), as the request layers read it.
 *
 * Leaf module: it imports types only, so the capability policy, the model profile
 * and the settings UI can all use it without a cycle.
 */
import type { ThinkingEffort } from '@/types/provider';
import type { ThinkingFormat } from './model-data/families';

export const THINKING_EFFORTS: readonly ThinkingEffort[] = ['off', 'low', 'high', 'max'];

/** A stored value that is not one of the four efforts (hand-edited settings) counts as unset. */
export function isThinkingEffort(value: unknown): value is ThinkingEffort {
  return typeof value === 'string' && (THINKING_EFFORTS as readonly string[]).includes(value);
}

/** Anthropic `budget_tokens` for each effort that thinks; `off` sends no thinking block at all. */
export const ANTHROPIC_THINKING_BUDGET = { low: 4096, high: 10000, max: 32000 } as const;

/**
 * OpenAI `reasoning_effort` for an effort. OpenAI reasoning models cannot switch
 * thinking off, so `off` keeps their lowest level; the code does not know which
 * models take `xhigh`, so `max` stays at `high`.
 */
export function openAIReasoningEffort(effort: ThinkingEffort): 'low' | 'high' {
  return effort === 'off' || effort === 'low' ? 'low' : 'high';
}

/**
 * The thinking formats whose request carries an on/off switch the effort setting
 * can write (`thinking`, `enable_thinking`, `chat_template_kwargs.enable_thinking`).
 * The other formats take their effort from `reasoning_effort` alone.
 */
export const THINKING_SWITCH_FORMATS: ReadonlySet<ThinkingFormat> = new Set<ThinkingFormat>([
  'deepseek',
  'qwen',
  'zai',
  'qwen-chat-template',
  'kimi',
]);
