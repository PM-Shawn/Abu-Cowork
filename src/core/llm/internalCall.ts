/**
 * Request options for the app's own one-shot model calls: the context summary,
 * memory extraction, the action reviewer, skill checks. Each asks for a short,
 * structured answer the app parses, under a fixed budget and often a timeout.
 *
 * Models that think by default (DeepSeek V4, Qwen3, Kimi K2.5, GLM) spend that
 * budget thinking first; on a small budget the answer comes back empty and the
 * feature silently fails (an action review with no verdict, a summary with no
 * text). None of these jobs needs deliberation: thinking is switched off where
 * the model has a switch. A model that thinks with no off switch (OpenAI
 * reasoning models, DeepSeek R1) gets room for its reasoning on top of the
 * answer instead, and the lowest effort it accepts.
 *
 * The user's 思考强度 setting is about their conversations and is left alone.
 */
import type { ProviderInstance } from '@/types/provider';
import type { ChatOptions } from './adapter';
import { resolveModelProfile } from './modelProfile';
import { resolveModelDeclared } from './resolveModelDeclared';
import { THINKING_SWITCH_FORMATS } from './thinkingEffort';

/** Room for reasoning when a model cannot be asked not to think. */
export const INTERNAL_REASONING_HEADROOM = 8192;

export type InternalCallOptions = Pick<ChatOptions, 'maxTokens' | 'enableThinking' | 'declaredCapabilities' | 'reasoningEffort'>;

export function internalCallOptions(input: {
  provider: ProviderInstance | undefined;
  modelId: string;
  baseUrl?: string;
  /** Tokens the answer itself needs. */
  answerTokens: number;
}): InternalCallOptions {
  const { provider, modelId, baseUrl, answerTokens } = input;
  const declared = resolveModelDeclared(provider, modelId);
  const profile = resolveModelProfile({ modelId, provider, declared, ...(baseUrl ? { baseUrl } : {}) });
  const thinking = profile.capabilities.thinking;
  if (!thinking || profile.wire.stripReasoningParams) return { maxTokens: answerTokens };

  // Anthropic thinks only when asked; `enableThinking: false` keeps it off.
  if (thinking === 'anthropic') return { maxTokens: answerTokens, enableThinking: false };

  if (THINKING_SWITCH_FORMATS.has(profile.wire.thinkingFormat)) {
    return {
      maxTokens: answerTokens,
      enableThinking: false,
      declaredCapabilities: { ...declared, thinkingEffort: 'off' },
    };
  }

  return {
    maxTokens: answerTokens + INTERNAL_REASONING_HEADROOM,
    ...(thinking === 'openai-reasoning' ? { reasoningEffort: 'low' as const } : {}),
  };
}
