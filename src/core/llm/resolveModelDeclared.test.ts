import { describe, it, expect } from 'vitest';
import { resolveModelDeclared } from './resolveModelDeclared';
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
