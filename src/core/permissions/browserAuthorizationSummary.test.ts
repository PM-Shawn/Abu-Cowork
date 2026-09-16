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
      viaEmbedAllowed: [],
      blocked: [],
    });
  });

  /**
   * A grant minted through the merged embedded-region prompt is SCOPED to the
   * page it was given on, and the screens that answer "where may a scheduled
   * task GO?" must not count it: a run arrives at a site as a top-level page,
   * which is the one role a scoped grant never covers. Reported separately,
   * the same way high-risk is, so the list does not silently look shorter than
   * the user's own settings.
   */
  it('keeps a via-embed grant out of the unattended reach, and says where it went', () => {
    const summary = summarizeBrowserAuthorization(
      { 'https://vendor.example.net': 'allowed', 'https://ok.example.com': 'allowed' },
      true,
      { 'https://vendor.example.net': { 'https://oa.example.com': true } },
    );

    expect(summary.reachableUnattended).toEqual(['https://ok.example.com']);
    expect(summary.viaEmbedAllowed).toEqual(['https://vendor.example.net']);
  });

  /**
   * The migrated shape (`{}` — "page unknown"). It is still a scoped grant, so
   * it is still not reach; reading `Object.keys(...).length > 0` instead of
   * "is there an entry" would have counted it as an ordinary standing grant
   * and told the user a scheduled task can go somewhere it cannot.
   */
  it('counts a pre-v51 grant with no page recorded the same way', () => {
    const summary = summarizeBrowserAuthorization(
      { 'https://vendor.example.net': 'allowed' },
      true,
      { 'https://vendor.example.net': {} },
    );

    expect(summary.reachableUnattended).toEqual([]);
    expect(summary.viaEmbedAllowed).toEqual(['https://vendor.example.net']);
  });

  it('leaves the reach alone when nothing is marked', () => {
    const summary = summarizeBrowserAuthorization(
      { 'https://vendor.example.net': 'allowed' },
      true,
      {},
    );

    expect(summary.reachableUnattended).toEqual(['https://vendor.example.net']);
    expect(summary.viaEmbedAllowed).toEqual([]);
  });
});
