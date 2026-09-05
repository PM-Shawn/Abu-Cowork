import { describe, expect, it } from 'vitest';
import { summarizeBrowserAuthorization } from './browserAuthorizationSummary';

describe('summarizeBrowserAuthorization', () => {
  const perms = {
    'https://reports.example.com': 'allowed',
    'https://blocked.example.com': 'denied',
    'https://www.paypal.com': 'allowed',
    'https://a.example.com': 'allowed',
  } as const;

  it('lists the allowed origins an unattended run can act on, sorted', () => {
    const s = summarizeBrowserAuthorization({ ...perms }, true);
    expect(s.reachableUnattended).toEqual([
      'https://a.example.com',
      'https://reports.example.com',
    ]);
  });

  it('reports nothing reachable while the master switch is off', () => {
    const s = summarizeBrowserAuthorization({ ...perms }, false);
    expect(s.masterSwitchOn).toBe(false);
    expect(s.reachableUnattended).toEqual([]);
    // The verdicts themselves are still reported — the switch gates reach, not
    // the user's own list.
    expect(s.blocked).toEqual(['https://blocked.example.com']);
  });

  it('separates an allowed origin that is high-risk anyway', () => {
    const s = summarizeBrowserAuthorization({ ...perms }, true);
    expect(s.highRiskAllowed).toEqual(['https://www.paypal.com']);
    expect(s.reachableUnattended).not.toContain('https://www.paypal.com');
  });

  it('keeps high-risk out even while the master switch is off', () => {
    expect(summarizeBrowserAuthorization({ ...perms }, false).highRiskAllowed)
      .toEqual(['https://www.paypal.com']);
  });

  it('handles an absent settings value as "nothing authorized"', () => {
    expect(summarizeBrowserAuthorization(undefined, undefined)).toEqual({
      masterSwitchOn: false,
      reachableUnattended: [],
      highRiskAllowed: [],
      blocked: [],
    });
  });
});
