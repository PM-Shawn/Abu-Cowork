import { describe, it, expect } from 'vitest';
import { resolveModelDeclared, resolveModelVision } from './resolveModelDeclared';
import { resolveModelProfile } from './modelProfile';
import type { ProviderInstance } from '@/types/provider';

function makeProvider(over: Partial<ProviderInstance>): ProviderInstance {
  return {
    id: 'p1', source: 'custom', name: 'P', enabled: true, apiFormat: 'openai-compatible',
    baseUrl: 'https://x/v1', apiKey: 'k', models: [], status: 'unchecked', sortOrder: 0,
    ...over,
  };
}

describe('resolveModelDeclared', () => {
  it('returns undefined when provider is undefined', () => {
    expect(resolveModelDeclared(undefined, 'm')).toBeUndefined();
  });
  it('returns undefined when neither model nor provider declares anything', () => {
    const p = makeProvider({ models: [{ id: 'm', label: 'm' }] });
    expect(resolveModelDeclared(p, 'm')).toBeUndefined();
  });
  it('per-model override wins over provider-level fallback (supportsImages)', () => {
    const p = makeProvider({
      declaredCapabilities: { supportsImages: true },
      models: [
        { id: 'vis', label: 'vis' },
        { id: 'noimg', label: 'noimg', declaredCapabilities: { supportsImages: false } },
      ],
    });
    expect(resolveModelDeclared(p, 'vis')?.supportsImages).toBe(true);
    expect(resolveModelDeclared(p, 'noimg')?.supportsImages).toBe(false);
  });
  it('endpoint-level fields always come from the provider', () => {
    const p = makeProvider({
      declaredCapabilities: { useRawUrl: true, thinkingFormat: 'qwen', supportsTools: true },
      models: [{ id: 'm', label: 'm', declaredCapabilities: { supportsTools: false } }],
    });
    const r = resolveModelDeclared(p, 'm');
    expect(r?.useRawUrl).toBe(true);
    expect(r?.thinkingFormat).toBe('qwen');
    expect(r?.supportsTools).toBe(false);
  });
  it('thinkingEffort: the model\'s own pick wins, else the provider-level one, else unset', () => {
    const p = makeProvider({
      declaredCapabilities: { thinkingEffort: 'high' },
      models: [
        { id: 'inherits', label: 'inherits' },
        { id: 'own', label: 'own', declaredCapabilities: { thinkingEffort: 'off' } },
      ],
    });
    expect(resolveModelDeclared(p, 'inherits')?.thinkingEffort).toBe('high');
    expect(resolveModelDeclared(p, 'own')?.thinkingEffort).toBe('off');
    const unset = makeProvider({ models: [{ id: 'm', label: 'm', declaredCapabilities: { supportsTools: true } }] });
    expect(resolveModelDeclared(unset, 'm')?.thinkingEffort).toBeUndefined();
  });
  it('thinkingEffort reaches a curated built-in provider, which declares nothing at provider level', () => {
    const p = makeProvider({
      id: 'deepseek',
      source: 'builtin',
      baseUrl: 'https://api.deepseek.com',
      declaredCapabilities: undefined,
      models: [
        { id: 'deepseek-flash', label: 'DeepSeek V4.1 Flash', declaredCapabilities: { thinkingEffort: 'max' } },
        { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
      ],
    });
    const picked = resolveModelDeclared(p, 'deepseek-flash');
    expect(picked?.thinkingEffort).toBe('max');
    // Only the pick is declared: nothing else is switched on, off or limited by it.
    expect(picked).toEqual({
      thinkingEffort: 'max',
      supportsTools: undefined, supportsImages: undefined, supportsReasoning: undefined,
      supportedEfforts: undefined, maxInputTokens: undefined, maxOutputTokens: undefined,
      parallelToolCalls: undefined, useRawUrl: undefined, thinkingFormat: undefined,
      maxTokensField: undefined, requiresToolResultName: undefined, reasoningReplay: undefined,
      toolSchemaDialect: undefined, sendTemperature: undefined, promptCacheKey: undefined,
    });
    // A sibling model that picked nothing still resolves to "auto-detect".
    expect(resolveModelDeclared(p, 'deepseek-v4-pro')).toBeUndefined();
  });
  it('the profile of a curated built-in DeepSeek model carries the pick and nothing else changes', () => {
    const provider = makeProvider({
      id: 'deepseek',
      source: 'builtin',
      baseUrl: 'https://api.deepseek.com',
      models: [{ id: 'deepseek-flash', label: 'DeepSeek V4.1 Flash', declaredCapabilities: { thinkingEffort: 'off' } }],
    });
    const plain = resolveModelProfile({
      modelId: 'deepseek-flash',
      provider: makeProvider({ id: 'deepseek', source: 'builtin', baseUrl: 'https://api.deepseek.com', models: [] }),
    });
    const picked = resolveModelProfile({ modelId: 'deepseek-flash', provider });
    expect(plain.wire.thinkingEffort).toBeNull();
    expect(picked.wire.thinkingEffort).toBe('off');
    expect(picked.wire.thinkingFormat).toBe('deepseek');
    expect(picked.wire.stripReasoningParams).toBe(false);
    // The off pick also drops the reasoning replay (there is no reasoning to hand back).
    expect(picked.wire.reasoningReplay).toBe('none');
    expect({ ...picked.wire, thinkingEffort: null, reasoningReplay: plain.wire.reasoningReplay }).toEqual(plain.wire);
    expect(picked.capabilities).toEqual(plain.capabilities);
  });
  it('unknown modelId falls back to provider-level only', () => {
    const p = makeProvider({
      declaredCapabilities: { supportsReasoning: false, maxInputTokens: 32768 },
      models: [{ id: 'm', label: 'm' }],
    });
    const r = resolveModelDeclared(p, 'does-not-exist');
    expect(r?.supportsReasoning).toBe(false);
    expect(r?.maxInputTokens).toBe(32768);
  });
});

describe('resolveModelVision', () => {
  it('follows the user\'s 能看图 choice first', () => {
    const provider = makeProvider({ models: [{ id: 'qwen3-vl-8b', label: 'q', declaredCapabilities: { supportsImages: false } }] });
    expect(resolveModelVision(provider, 'qwen3-vl-8b')).toBe(false);
  });

  it('falls back to the model name', () => {
    expect(resolveModelVision(makeProvider({ models: [{ id: 'qwen3-vl-8b', label: 'q' }] }), 'qwen3-vl-8b')).toBe(true);
    expect(resolveModelVision(undefined, 'deepseek-chat')).toBe(false);
  });
});
