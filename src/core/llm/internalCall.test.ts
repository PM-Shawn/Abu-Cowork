import { describe, expect, it } from 'vitest';
import type { ProviderInstance } from '@/types/provider';
import { INTERNAL_REASONING_HEADROOM, internalCallOptions } from './internalCall';

function provider(
  baseUrl: string,
  modelId: string,
  declared?: ProviderInstance['models'][number]['declaredCapabilities'],
  apiFormat: ProviderInstance['apiFormat'] = 'openai-compatible',
): ProviderInstance {
  return {
    id: 'p', source: 'custom', name: 'p', enabled: true, apiFormat, baseUrl, apiKey: 'k',
    models: [{ id: modelId, label: modelId, ...(declared ? { declaredCapabilities: declared } : {}) }],
    status: 'verified', sortOrder: 1, userAdded: true,
  };
}
const options = (p: ProviderInstance, modelId: string, answerTokens = 300) => {
  // The model's declarations ride along; the cases below are about what changes.
  const { declaredCapabilities, ...rest } = internalCallOptions({ provider: p, modelId, answerTokens });
  void declaredCapabilities;
  return rest;
};
const claude = (modelId: string, declared?: ProviderInstance['models'][number]['declaredCapabilities']) =>
  provider('https://api.anthropic.com', modelId, declared, 'anthropic');

describe('internalCallOptions', () => {
  describe('models whose thinking can be turned off: no thinking, under the answer budget', () => {
    it('DeepSeek V4.1 Flash, whatever effort the user picked for chats', () => {
      const p = provider('https://api.deepseek.com', 'deepseek-flash', { thinkingEffort: 'max' });
      expect(options(p, 'deepseek-flash', 1024)).toEqual({ maxTokens: 1024, enableThinking: false });
    });
    it('Claude Opus 5 (thinks by default, accepts disabled)', () => {
      expect(options(claude('claude-opus-5'), 'claude-opus-5', 60)).toEqual({ maxTokens: 60, enableThinking: false });
    });
    it('Claude Sonnet 5 and Haiku 5.5', () => {
      expect(options(claude('claude-sonnet-5'), 'claude-sonnet-5')).toEqual({ maxTokens: 300, enableThinking: false });
      expect(options(claude('claude-haiku-5-5'), 'claude-haiku-5-5')).toEqual({ maxTokens: 300, enableThinking: false });
    });
    it('a Claude model that thinks only when asked', () => {
      expect(options(claude('claude-opus-4-5'), 'claude-opus-4-5')).toEqual({ maxTokens: 300, enableThinking: false });
      expect(options(claude('claude-opus-4-8'), 'claude-opus-4-8')).toEqual({ maxTokens: 300, enableThinking: false });
    });
    it('gpt-5.1 takes reasoning_effort none', () => {
      expect(options(provider('https://api.openai.com/v1', 'gpt-5.1'), 'gpt-5.1'))
        .toEqual({ maxTokens: 300, reasoningEffort: 'none' });
    });
  });

  describe('models that always think: room for the reasoning on top of the answer', () => {
    it.each(['claude-fable-5', 'claude-opus-5-5'])('%s cannot be turned off', (modelId) => {
      expect(options(claude(modelId), modelId, 60)).toEqual({ maxTokens: 60 + INTERNAL_REASONING_HEADROOM });
    });
    it('an OpenAI model without a none level, at the lowest effort', () => {
      expect(options(provider('https://api.openai.com/v1', 'o4-mini'), 'o4-mini')).toEqual({
        maxTokens: 300 + INTERNAL_REASONING_HEADROOM,
        reasoningEffort: 'low',
      });
    });
  });

  it('leaves a model that does not think alone', () => {
    expect(options(provider('https://api.openai.com/v1', 'gpt-4o'), 'gpt-4o')).toEqual({ maxTokens: 300 });
  });

  it('leaves a model alone when the user said it does not reason', () => {
    const p = provider('https://api.deepseek.com', 'deepseek-flash', { supportsReasoning: false });
    expect(options(p, 'deepseek-flash')).toEqual({ maxTokens: 300 });
  });
});

describe('internalCallOptions declarations', () => {
  it('hands the model\'s own declarations to the adapter unchanged, the user\'s chat pick included', () => {
    const p = provider('https://api.deepseek.com', 'deepseek-flash', { thinkingEffort: 'max' });
    expect(internalCallOptions({ provider: p, modelId: 'deepseek-flash', answerTokens: 300 }).declaredCapabilities)
      .toEqual({ thinkingEffort: 'max' });
  });
});
