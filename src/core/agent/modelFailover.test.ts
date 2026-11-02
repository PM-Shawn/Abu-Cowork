import { describe, it, expect } from 'vitest';
import {
  buildFailoverChain,
  createFailoverState,
  failoverModelLabel,
  isFailoverWorthyError,
  nextFailoverCandidate,
  MAX_FAILOVER_ATTEMPTS,
} from './modelFailover';
import { LLMError } from '../llm/adapter';
import type { ProviderInstance, ActiveModel } from '../../types/provider';

function provider(id: string, models: string[], overrides: Partial<ProviderInstance> = {}): ProviderInstance {
  return {
    id,
    name: id,
    apiFormat: 'openai',
    baseUrl: 'https://example.invalid',
    apiKey: 'k',
    enabled: true,
    userAdded: true,
    source: 'builtin',
    status: 'verified',
    models: models.map((m) => ({ id: m, label: m })),
    capabilities: [],
    ...overrides,
  } as unknown as ProviderInstance;
}

const CURRENT: ActiveModel = { providerId: 'p1', modelId: 'm1' };

function settings(
  providers: ProviderInstance[],
  favorites: ActiveModel[] = [],
  recents: ActiveModel[] = [],
) {
  return { providers, favoriteModels: favorites, recentModels: recents };
}

describe('buildFailoverChain', () => {
  it('orders favorites before recents and dedupes against the current model', () => {
    const chain = buildFailoverChain(
      settings(
        [provider('p1', ['m1']), provider('p2', ['m2', 'm3']), provider('p3', ['m4'])],
        [{ providerId: 'p3', modelId: 'm4' }],
        [{ providerId: 'p2', modelId: 'm3' }, { providerId: 'p3', modelId: 'm4' }],
      ),
      CURRENT,
    );
    expect(chain).toEqual([
      { providerId: 'p3', modelId: 'm4' },
      { providerId: 'p2', modelId: 'm3' },
    ]);
  });

  it('filters unavailable entries (disabled provider, removed model)', () => {
    const chain = buildFailoverChain(
      settings(
        [provider('p1', ['m1']), provider('p2', ['m2'], { enabled: false }), provider('p3', ['m4'])],
        [{ providerId: 'p2', modelId: 'm2' }, { providerId: 'p3', modelId: 'gone' }, { providerId: 'p3', modelId: 'm4' }],
      ),
      CURRENT,
    );
    expect(chain).toEqual([{ providerId: 'p3', modelId: 'm4' }]);
  });

  it('appends the first enabled provider model as the floor', () => {
    const chain = buildFailoverChain(
      settings([provider('p1', ['m1']), provider('p2', ['m2', 'm3'])]),
      CURRENT,
    );
    expect(chain).toEqual([{ providerId: 'p2', modelId: 'm2' }]);
  });

  it('caps the chain at MAX_FAILOVER_ATTEMPTS', () => {
    const favorites = [1, 2, 3, 4].map((n) => ({ providerId: `p${n + 1}`, modelId: `m${n + 1}` }));
    const providers = [1, 2, 3, 4, 5].map((n) => provider(`p${n}`, [`m${n}`]));
    const chain = buildFailoverChain(settings(providers, favorites), CURRENT);
    expect(chain).toHaveLength(MAX_FAILOVER_ATTEMPTS);
  });

  it('returns empty when nothing else is available', () => {
    expect(buildFailoverChain(settings([provider('p1', ['m1'])]), CURRENT)).toEqual([]);
  });
});

describe('failover state', () => {
  it('hands out candidates once and records the active model', () => {
    const state = createFailoverState([
      { providerId: 'p2', modelId: 'm2' },
      { providerId: 'p3', modelId: 'm3' },
    ]);
    expect(nextFailoverCandidate(state)).toEqual({ providerId: 'p2', modelId: 'm2' });
    expect(state.active).toEqual({ providerId: 'p2', modelId: 'm2' });
    expect(nextFailoverCandidate(state)).toEqual({ providerId: 'p3', modelId: 'm3' });
    expect(nextFailoverCandidate(state)).toBeNull();
  });
});

describe('isFailoverWorthyError', () => {
  it('accepts quota and rate-limit errors, rejects everything else', () => {
    expect(isFailoverWorthyError(new LLMError('x', 'quota_exceeded', { retryable: false }))).toBe(true);
    expect(isFailoverWorthyError(new LLMError('x', 'rate_limit', { retryable: true }))).toBe(true);
    expect(isFailoverWorthyError(new LLMError('x', 'server_error', { retryable: true }))).toBe(false);
    expect(isFailoverWorthyError(new LLMError('x', 'cancelled', { retryable: false }))).toBe(false);
    expect(isFailoverWorthyError(new LLMError('x', 'context_too_long', { retryable: false }))).toBe(false);
    expect(isFailoverWorthyError(new Error('exceed quota limit'))).toBe(false);
    expect(isFailoverWorthyError(null)).toBe(false);
  });
});

describe('failoverModelLabel', () => {
  it('joins provider and model ids', () => {
    expect(failoverModelLabel({ providerId: 'p2', modelId: 'glm-5.3' })).toBe('p2/glm-5.3');
  });
});
