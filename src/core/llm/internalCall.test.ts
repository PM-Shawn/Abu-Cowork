import { describe, expect, it } from 'vitest';
import type { ProviderInstance } from '@/types/provider';
import { INTERNAL_REASONING_HEADROOM, internalCallOptions } from './internalCall';

function provider(baseUrl: string, modelId: string, declared?: ProviderInstance['models'][number]['declaredCapabilities']): ProviderInstance {
  return {
    id: 'p', source: 'custom', name: 'p', enabled: true, apiFormat: 'openai-compatible', baseUrl, apiKey: 'k',
    models: [{ id: modelId, label: modelId, ...(declared ? { declaredCapabilities: declared } : {}) }],
    status: 'verified', sortOrder: 1, userAdded: true,
  };
}

describe('internalCallOptions', () => {
  it('switches thinking off for DeepSeek V4.1 Flash, whatever effort the user picked for chats', () => {
    const p = provider('https://api.deepseek.com', 'deepseek-flash', { thinkingEffort: 'max' });
    expect(internalCallOptions({ provider: p, modelId: 'deepseek-flash', answerTokens: 1024 })).toEqual({
      maxTokens: 1024,
      enableThinking: false,
      declaredCapabilities: expect.objectContaining({ thinkingEffort: 'off' }),
    });
  });

  it('keeps Claude from thinking without touching the budget', () => {
    const p = provider('https://api.anthropic.com', 'claude-opus-4-5');
    expect(internalCallOptions({ provider: p, modelId: 'claude-opus-4-5', answerTokens: 300 })).toEqual({ maxTokens: 300, enableThinking: false });
  });

  it('gives a model that cannot stop thinking room for it, at the lowest effort', () => {
    const p = provider('https://api.openai.com/v1', 'o4-mini');
    expect(internalCallOptions({ provider: p, modelId: 'o4-mini', answerTokens: 300 })).toEqual({
      maxTokens: 300 + INTERNAL_REASONING_HEADROOM,
      reasoningEffort: 'low',
    });
  });

  it('leaves a model that does not think alone', () => {
    const p = provider('https://api.openai.com/v1', 'gpt-4o');
    expect(internalCallOptions({ provider: p, modelId: 'gpt-4o', answerTokens: 300 })).toEqual({ maxTokens: 300 });
  });

  it('leaves a model alone when the user said it does not reason', () => {
    const p = provider('https://api.deepseek.com', 'deepseek-flash', { supportsReasoning: false });
    expect(internalCallOptions({ provider: p, modelId: 'deepseek-flash', answerTokens: 300 })).toEqual({ maxTokens: 300 });
  });
});
