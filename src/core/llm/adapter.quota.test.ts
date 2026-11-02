import { describe, it, expect } from 'vitest';
import { classifyError, isQuotaError, isQuotaProseMessage, LLMError } from './adapter';

describe('classifyError quota prose on 5xx', () => {
  it('classifies a 502 whose body says the quota is spent as quota_exceeded, not retryable', () => {
    const err = classifyError(502, JSON.stringify({ error: { message: 'ZCode did not stream: exceed quota limit' } }));
    expect(err.code).toBe('quota_exceeded');
    expect(err.retryable).toBe(false);
    expect(err.statusCode).toBe(502);
  });

  it('matches quota limit / exceeded / exhausted / insufficient balance prose', () => {
    expect(isQuotaProseMessage('exceed quota limit')).toBe(true);
    expect(isQuotaProseMessage('quota exceeded for this org')).toBe(true);
    expect(isQuotaProseMessage('quota exhausted, please top up')).toBe(true);
    expect(isQuotaProseMessage('insufficient balance')).toBe(true);
    expect(isQuotaProseMessage('insufficient credit')).toBe(true);
  });

  it('does not misclassify an unrelated 500 that merely mentions quota in passing', () => {
    expect(isQuotaProseMessage('internal error while rendering the quota dashboard')).toBe(false);
    expect(isQuotaProseMessage('upstream timeout')).toBe(false);
  });

  it('keeps a plain 502 as retryable server_error', () => {
    const err = classifyError(502, 'Bad Gateway');
    expect(err.code).toBe('server_error');
    expect(err.retryable).toBe(true);
  });

  it('keeps the structured 429 quota_exceeded path unchanged', () => {
    const err = classifyError(429, JSON.stringify({ error: { code: 'quota_exceeded', message: 'spent' } }));
    expect(err.code).toBe('quota_exceeded');
    expect(err.retryable).toBe(false);
  });

  it('isQuotaError narrows LLMError by code', () => {
    const err = classifyError(502, JSON.stringify({ error: { message: 'exceed quota limit' } }));
    expect(isQuotaError(err)).toBe(true);
    expect(isQuotaError(new LLMError('x', 'server_error', { retryable: true }))).toBe(false);
    expect(isQuotaError(new Error('exceed quota limit'))).toBe(false);
  });
});
