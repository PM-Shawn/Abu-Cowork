import { describe, expect, it } from 'vitest';
import type { ProviderInstance } from '@/types/provider';
import type { ModelCapabilities } from './modelCapabilities';
import { resolveRequestBudget } from './requestBudget';

const caps: ModelCapabilities = {
  vision: true, thinking: false, toolResultImages: 'native', documentBlock: false,
  maxOutputTokens: 16_384, outputCeiling: 32_768, contextWindow: 128_000,
};
const provider: ProviderInstance = {
  id: 'provider', source: 'custom', name: 'Provider', enabled: true,
  apiFormat: 'openai-compatible', baseUrl: 'https://model.example.net/v1', apiKey: 'key',
  models: [{ id: 'gpt-4o', label: 'Model', contextWindow: 128_000 }],
  status: 'verified', sortOrder: 0, userAdded: true,
};

describe('resolveRequestBudget', () => {
  it('limits the input window while reserving output against the service window', () => {
    const result = resolveRequestBudget('gpt-4o', caps, provider, { contextWindowSize: 20_000, maxOutputTokens: 12_000 });
    expect(result).toMatchObject({ contextWindowSize: 20_000, reserveWindowSize: 128_000, outputCeiling: 32_768, localServer: false });
    expect(result.reasoningParams.maxTokens).toBe(12_000);
    expect(result.requestedContextLength).toBeUndefined();
  });

  it('uses a user-declared local window and sends exactly that length to the adapter', () => {
    const local: ProviderInstance = { ...provider, id: 'ollama', source: 'builtin', baseUrl: 'http://127.0.0.1:11434', models: [
      { id: 'gpt-4o', label: 'Model', contextWindow: 128_000, declaredCapabilities: { maxInputTokens: 8192, maxOutputTokens: 4096 } },
    ] };
    const result = resolveRequestBudget('gpt-4o', caps, local, { contextWindowSize: 4096, maxOutputTokens: 4096 });
    expect(result).toMatchObject({ contextWindowSize: 8192, reserveWindowSize: 8192, requestedContextLength: 8192, localServer: true });
    expect(result.reasoningParams.maxTokens).toBe(2048);
  });

  it('does not pass an inferred local context length as a user setting', () => {
    const local: ProviderInstance = { ...provider, id: 'ollama', source: 'builtin', baseUrl: 'http://127.0.0.1:11434', models: [{ id: 'gpt-4o', label: 'Model' }] };
    const result = resolveRequestBudget('gpt-4o', caps, local, { contextWindowSize: 200_000, maxOutputTokens: 4096 });
    expect(result.contextWindowSize).toBe(32768);
    expect(result.localServer).toBe(true);
    expect(result.requestedContextLength).toBeUndefined();
  });

  it('applies discovered output limits and preserves a valid reasoning budget', () => {
    const result = resolveRequestBudget('gpt-4o', { ...caps, thinking: 'qwen' }, provider, { contextWindowSize: 200_000, maxOutputTokens: 4096 }, {
      maxOutputTokens: 2048, contextWindow: 8192, contextWindowProbe: 128_000, source: 'error-derived', updatedAt: 1,
    });
    expect(result.contextWindowSize).toBe(8192);
    expect(result.outputCeiling).toBe(2048);
    expect(result.reasoningParams.maxTokens).toBe(2048);
    expect(result.reasoningParams.thinkingBudget).toBeLessThan(result.reasoningParams.maxTokens);
  });

  it('carries the thinking effort picked for the model into the reasoning params', () => {
    const picked: ProviderInstance = {
      ...provider,
      models: [{ id: 'gpt-4o', label: 'Model', contextWindow: 128_000, declaredCapabilities: { thinkingEffort: 'off' } }],
    };
    const claude: ModelCapabilities = { ...caps, thinking: 'anthropic' };
    const settings = { contextWindowSize: 200_000, maxOutputTokens: 4096 };

    expect(resolveRequestBudget('gpt-4o', claude, provider, settings).reasoningParams).toMatchObject({ enableThinking: true, thinkingBudget: 10000 });
    expect(resolveRequestBudget('gpt-4o', claude, picked, settings).reasoningParams.enableThinking).toBe(false);
  });

  it('discards a learned input window after the service reports a changed window', () => {
    const result = resolveRequestBudget('gpt-4o', caps, provider, { contextWindowSize: 200_000, maxOutputTokens: 4096 }, {
      contextWindow: 8192, contextWindowProbe: 32_768, source: 'error-derived', updatedAt: 1,
    }, 64_000);
    expect(result.contextWindowSize).toBe(64_000);
  });
});
