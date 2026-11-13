/**
 * Request options for the app's own one-shot model calls: the context summary,
 * memory extraction, the action reviewer, skill checks, the conversation title.
 * Each asks for a short, structured answer the app parses, under a fixed budget
 * and often a timeout.
 *
 * Models that think by default (DeepSeek V4, Qwen3, Kimi K2.5, GLM, Claude Opus 5
 * and the other adaptive Claude models) spend that budget thinking first, and
 * thinking tokens count as output: on a small budget the answer comes back empty
 * and the feature silently fails (an action review with no verdict, a summary
 * with no text, a title never written). None of these jobs needs deliberation, so
 * the model's own thinking control decides what each call sends:
 *  - a model whose thinking can be turned off is asked for no thinking, in the
 *    field it accepts (`thinking: disabled`, a DeepSeek / Qwen / Kimi switch,
 *    `reasoning_effort: none`, Ollama's `think: false`), under the answer's budget;
 *  - a model that always thinks (Fable 5, Opus 5.5, OpenAI models without `none`,
 *    DeepSeek R1) gets room for its reasoning on top of the answer instead.
 *
 * The user's 思考强度 setting is about their conversations and is left alone.
 */
import type { ProviderInstance } from '@/types/provider';
import type { ChatOptions } from './adapter';
import { resolveModelProfile } from './modelProfile';
import { resolveModelDeclared } from './resolveModelDeclared';

/** Room for reasoning when a model cannot be asked not to think. */
export const INTERNAL_REASONING_HEADROOM = 8192;

export type InternalCallOptions = Pick<ChatOptions, 'maxTokens' | 'enableThinking' | 'reasoningEffort' | 'declaredCapabilities'>;

/**
 * The model's own declarations ride along unchanged, so the adapter resolves the same profile
 * this function read its thinking control from.
 */
export function internalCallOptions(input: {
  provider: ProviderInstance | undefined;
  modelId: string;
  baseUrl?: string;
  /** Tokens the answer itself needs. */
  answerTokens: number;
}): InternalCallOptions {
  const options = internalCallThinking(input);
  const declared = resolveModelDeclared(input.provider, input.modelId);
  return declared ? { ...options, declaredCapabilities: declared } : options;
}

function internalCallThinking(input: {
  provider: ProviderInstance | undefined;
  modelId: string;
  baseUrl?: string;
  answerTokens: number;
}): InternalCallOptions {
  const { provider, modelId, baseUrl, answerTokens } = input;
  const declared = resolveModelDeclared(provider, modelId);
  const profile = resolveModelProfile({ modelId, provider, declared, ...(baseUrl ? { baseUrl } : {}) });
  const { thinkingControl: control } = profile.wire;
  const room = { maxTokens: answerTokens + INTERNAL_REASONING_HEADROOM };

  switch (control.kind) {
    case 'anthropic-budget':
    case 'switch':
      // Off is the absence of thinking (budget models think only when asked) or the model's switch.
      return { maxTokens: answerTokens, enableThinking: false };
    case 'anthropic-adaptive':
      return control.off === null ? room : { maxTokens: answerTokens, enableThinking: false };
    case 'reasoning-effort':
      return control.none ? { maxTokens: answerTokens, reasoningEffort: 'none' } : { ...room, reasoningEffort: 'low' };
    case 'none':
      break;
  }
  // No control reaches the request: a model that does not think is left alone, one that does
  // (a reasoning model on a wire with no knob) gets room for it, at the lowest effort it takes.
  if (!profile.capabilities.thinking || profile.wire.stripReasoningParams) return { maxTokens: answerTokens };
  return profile.capabilities.thinking === 'openai-reasoning' ? { ...room, reasoningEffort: 'low' } : room;
}
