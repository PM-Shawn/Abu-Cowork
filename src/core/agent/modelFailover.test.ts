import { describe, expect, it } from 'vitest';
import { LLMError } from '../llm/adapter';
import { failoverModelLabel, isFailoverWorthyError } from './modelFailover';

describe('model recovery errors', () => {
  it('offers selection for quota and rate limits', () => {
    expect(isFailoverWorthyError(new LLMError('quota', 'quota_exceeded', { retryable: false }))).toBe(true);
    expect(isFailoverWorthyError(new LLMError('rate', 'rate_limit', { retryable: true }))).toBe(true);
  });
  it('preserves cancellation and unrelated errors', () => {
    for (const code of ['cancelled', 'server_error', 'context_too_long'] as const) {
      expect(isFailoverWorthyError(new LLMError('error', code, { retryable: false }))).toBe(false);
    }
    expect(isFailoverWorthyError(new Error('quota'))).toBe(false);
    expect(isFailoverWorthyError(null)).toBe(false);
  });
  it('labels the selected provider and model', () => {
    expect(failoverModelLabel({ providerId: 'provider', modelId: 'model' })).toBe('provider/model');
  });
});
