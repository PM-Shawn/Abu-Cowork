import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordProviderCallOutcome,
  getProviderCallHealth,
  isConfigFailureCode,
  __resetProviderCallHealth,
} from './providerCallHealth';

describe('providerCallHealth', () => {
  beforeEach(() => {
    __resetProviderCallHealth();
  });

  it('records and reads back an outcome for a provider id', () => {
    recordProviderCallOutcome('provider-a', { ok: false, code: 'not_found', at: 1000 });
    expect(getProviderCallHealth('provider-a')).toEqual({ ok: false, code: 'not_found', at: 1000 });
  });

  it('returns undefined for a provider with no recorded outcome', () => {
    expect(getProviderCallHealth('never-called')).toBeUndefined();
  });

  it('a later success overwrites a prior failure', () => {
    recordProviderCallOutcome('provider-a', { ok: false, code: 'not_found', at: 1000 });
    recordProviderCallOutcome('provider-a', { ok: true, at: 2000 });
    expect(getProviderCallHealth('provider-a')).toEqual({ ok: true, at: 2000 });
  });

  it('is a no-op when providerId is undefined', () => {
    recordProviderCallOutcome(undefined, { ok: false, code: 'not_found', at: 1000 });
    expect(getProviderCallHealth('undefined')).toBeUndefined();
  });

  it('__resetProviderCallHealth clears all recorded outcomes', () => {
    recordProviderCallOutcome('provider-a', { ok: true, at: 1000 });
    recordProviderCallOutcome('provider-b', { ok: false, code: 'network_error', at: 1000 });
    __resetProviderCallHealth();
    expect(getProviderCallHealth('provider-a')).toBeUndefined();
    expect(getProviderCallHealth('provider-b')).toBeUndefined();
  });

  describe('isConfigFailureCode', () => {
    it('flags persistent config-class codes as worth surfacing', () => {
      expect(isConfigFailureCode('not_found')).toBe(true);
      expect(isConfigFailureCode('authentication')).toBe(true);
      expect(isConfigFailureCode('invalid_request')).toBe(true);
    });

    it('does NOT flag transient / non-config codes', () => {
      for (const code of ['rate_limit', 'overloaded', 'server_error', 'network_error', 'network_blocked', 'context_too_long', 'cancelled', 'unknown'] as const) {
        expect(isConfigFailureCode(code)).toBe(false);
      }
    });
  });
});
