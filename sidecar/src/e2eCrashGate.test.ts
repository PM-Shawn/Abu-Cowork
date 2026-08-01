import { describe, expect, it } from 'vitest';
import { isAuthorizedE2ECrash } from './e2eCrashGate';

describe('isAuthorizedE2ECrash', () => {
  it('stays disabled when the launch has no E2E crash token', () => {
    expect(isAuthorizedE2ECrash({ token: 'test-token' }, undefined)).toBe(false);
  });

  it('rejects missing, malformed, and incorrect tokens', () => {
    expect(isAuthorizedE2ECrash(undefined, 'test-token')).toBe(false);
    expect(isAuthorizedE2ECrash([], 'test-token')).toBe(false);
    expect(isAuthorizedE2ECrash({}, 'test-token')).toBe(false);
    expect(isAuthorizedE2ECrash({ token: 'wrong-token' }, 'test-token')).toBe(false);
  });

  it('accepts only the exact launch token', () => {
    expect(isAuthorizedE2ECrash({ token: 'test-token' }, 'test-token')).toBe(true);
  });
});
