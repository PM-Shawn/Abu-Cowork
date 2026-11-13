/**
 * The user's per-model thinking effort (设置 → 思考强度), as the request layers read it.
 *
 * Leaf module: it imports types only. Which levels a model carries, and what each one
 * puts on the wire, is `model-data/thinkingControl.ts`.
 */
import type { ThinkingEffort } from '@/types/provider';

export const THINKING_EFFORTS: readonly ThinkingEffort[] = ['off', 'low', 'high', 'max'];

/** A stored value that is not one of the four efforts (hand-edited settings) counts as unset. */
export function isThinkingEffort(value: unknown): value is ThinkingEffort {
  return typeof value === 'string' && (THINKING_EFFORTS as readonly string[]).includes(value);
}
