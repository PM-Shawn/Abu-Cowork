/**
 * Absolute truths about the browser gate's decision layer.
 *
 * The companion contract test proves that `registry.ts` and this function agree
 * — but agreement alone cannot catch a rule being deleted, because both sides
 * read the same function and would move together. (Verified: removing the
 * blocked-site rule and the state-changing ceiling left the whole contract
 * suite green.) So this file states what each rule DOES, one case per rule, and
 * it is what turns red when one is dropped.
 *
 * Deliberately at the pure layer rather than through `checkToolApproval`: these
 * are statements about the rules, and running them here costs no MCP fake, no
 * store, and no approval seam.
 */
import { describe, expect, it } from 'vitest';
import { evaluateBrowserGate, type BrowserGateFacts } from './browserGateEvaluation';
import {
  DEFAULT_BROWSER_OPERATION_POLICY,
  type BrowserOperationPolicy,
} from './browserToolPolicy';
import {
  buildIMRunPermissionCeiling,
  buildScheduledRunPermissionCeiling,
  buildTriggerRunPermissionCeiling,
} from './runPermissionCeiling';

const ALL_ALLOW: BrowserOperationPolicy = {
  readOnly: 'allow',
  interactive: 'allow',
  scripting: 'allow',
};

function facts(overrides: Partial<BrowserGateFacts> = {}): BrowserGateFacts {
  return {
    opClass: 'interactive',
    runMode: 'attended',
    policy: ALL_ALLOW,
    masterSwitchUnattended: true,
    siteVerdict: 'allowed',
    permissionMode: 'standard',
    runPermissionCeiling: null,
    toolTargetsPage: true,
    originResolved: true,
    answersPageDialog: false,
    loginRequired: false,
    conversationGrant: false,
    confirmationChannelAvailable: true,
    originKnown: true,
    ...overrides,
  };
}

describe('evaluateBrowserGate', () => {
  describe('a site the user blocked', () => {
    // Redundant with `decideBrowserOperation`'s own step 1 for the DECISION —
    // both say deny — but not for the REASON, and the reason is what the user
    // reads. Without this rule an attended refusal on a blocked site would be
    // reported as 「你的设置不允许」, sending the user to a policy row they never
    // touched instead of to the site they blocked.
    it('is refused, and named as the site rather than as the policy', () => {
      const evaluation = evaluateBrowserGate(facts({ siteVerdict: 'denied' }));
      expect(evaluation.outcome).toBe('deny');
      expect(evaluation.denialReason).toBe('site-denied');
    });

    it('is refused for READS too when nobody is watching', () => {
      const evaluation = evaluateBrowserGate(facts({
        opClass: 'read-only',
        runMode: 'unattended',
        siteVerdict: 'denied',
      }));
      expect(evaluation.outcome).toBe('deny');
      expect(evaluation.denialReason).toBe('site-denied');
    });
  });

  describe('the run permission ceiling', () => {
    // The tool-roster ceiling (`decideToolUnderRunPermissionCeiling`) is a
    // different check and does NOT cover this: a `custom` trigger that
    // whitelists `abu-browser__*` passes the roster and still may not act.
    it('refuses a state-changing action under a custom ceiling that lists browser tools', () => {
      const ceiling = buildTriggerRunPermissionCeiling({
        capability: 'custom',
        permissions: { allowedTools: ['abu-browser__*'] },
      } as never);
      const evaluation = evaluateBrowserGate(facts({
        runMode: 'unattended',
        runPermissionCeiling: ceiling,
      }));
      expect(evaluation.outcome).toBe('deny');
      expect(evaluation.ceilingDecision?.decision).toBe('deny');
    });

    it('refuses a state-changing action on a read-only IM channel', () => {
      const evaluation = evaluateBrowserGate(facts({
        runMode: 'unattended',
        runPermissionCeiling: buildIMRunPermissionCeiling('read_tools'),
      }));
      expect(evaluation.outcome).toBe('deny');
      expect(evaluation.ceilingDecision?.decision).toBe('deny');
    });

    it('leaves READS alone — only state-changing calls are ceiling-checked here', () => {
      const evaluation = evaluateBrowserGate(facts({
        opClass: 'read-only',
        runMode: 'unattended',
        runPermissionCeiling: buildIMRunPermissionCeiling('read_tools'),
      }));
      expect(evaluation.ceilingDecision).toBeNull();
      expect(evaluation.outcome).toBe('allow');
    });

    it('routes a scheduled ceiling through the operation policy instead of refusing outright', () => {
      const ceiling = buildScheduledRunPermissionCeiling(['abu-browser__click']);
      expect(evaluateBrowserGate(facts({
        runMode: 'unattended',
        runPermissionCeiling: ceiling,
      })).outcome).toBe('allow');
      expect(evaluateBrowserGate(facts({
        runMode: 'unattended',
        runPermissionCeiling: ceiling,
        policy: { ...ALL_ALLOW, interactive: 'deny' },
      })).outcome).toBe('deny');
    });
  });

  describe('automatic runs', () => {
    it('are refused entirely while the master switch is off', () => {
      const evaluation = evaluateBrowserGate(facts({
        opClass: 'read-only',
        runMode: 'unattended',
        masterSwitchUnattended: false,
      }));
      expect(evaluation.outcome).toBe('deny');
      expect(evaluation.denialReason).toBe('master-switch-off');
    });

    it('may act only on a site carrying a standing "always allow"', () => {
      const evaluation = evaluateBrowserGate(facts({
        runMode: 'unattended',
        siteVerdict: 'default',
      }));
      expect(evaluation.outcome).toBe('deny');
      expect(evaluation.denialReason).toBe('site-not-allowed');
    });

    it('may still READ a site with no standing grant', () => {
      const evaluation = evaluateBrowserGate(facts({
        opClass: 'read-only',
        runMode: 'unattended',
        siteVerdict: 'default',
      }));
      expect(evaluation.outcome).toBe('allow');
    });

    it('refuse a page whose origin could not be verified', () => {
      const evaluation = evaluateBrowserGate(facts({
        opClass: 'read-only',
        runMode: 'unattended',
        originResolved: false,
      }));
      expect(evaluation.outcome).toBe('deny');
      expect(evaluation.denialReason).toBe('origin-unverified');
    });

    it('do not refuse a tool that acts on no page at all', () => {
      const evaluation = evaluateBrowserGate(facts({
        opClass: 'read-only',
        runMode: 'unattended',
        originResolved: false,
        toolTargetsPage: false,
      }));
      expect(evaluation.outcome).toBe('allow');
    });

    it('refuse a state-changing action behind a sign-in wall, but not the read that reveals it', () => {
      expect(evaluateBrowserGate(facts({
        runMode: 'unattended',
        loginRequired: true,
      })).denialReason).toBe('login-required');
      expect(evaluateBrowserGate(facts({
        opClass: 'read-only',
        runMode: 'unattended',
        loginRequired: true,
      })).outcome).toBe('allow');
    });

    // Faithful reproduction of what ships, not an endorsement: the gate asks a
    // human and refuses anyway. Pinned so a future fix is a deliberate change
    // rather than a silent one.
    it('ask over IM before refusing for a missing standing grant', () => {
      const evaluation = evaluateBrowserGate(facts({
        runMode: 'unattended',
        siteVerdict: 'default',
        policy: { ...ALL_ALLOW, interactive: 'ask' },
      }));
      expect(evaluation.ask?.channel).toBe('im');
      expect(evaluation.outcome).toBe('deny');
      expect(evaluation.denialReason).toBe('site-not-allowed');
    });

    it('never offer a standing grant over the IM channel', () => {
      const evaluation = evaluateBrowserGate(facts({
        runMode: 'unattended',
        policy: { ...ALL_ALLOW, interactive: 'ask' },
      }));
      expect(evaluation.ask).toEqual({
        channel: 'im',
        offersPersistentGrant: false,
        refusedReason: 'approval-refused',
      });
    });
  });

  describe('money-movement and government pages', () => {
    it('are refused to an automatic run, for every class including reads', () => {
      for (const opClass of ['read-only', 'interactive', 'scripting'] as const) {
        const evaluation = evaluateBrowserGate(facts({
          opClass,
          runMode: 'unattended',
          siteVerdict: 'high-risk',
        }));
        expect(evaluation.outcome).toBe('deny');
        expect(evaluation.denialReason).toBe('high-risk-site');
      }
    });

    it('force a confirmation on an ACTING class while the user is watching', () => {
      const evaluation = evaluateBrowserGate(facts({ siteVerdict: 'high-risk' }));
      expect(evaluation.ask?.channel).toBe('dialog');
      expect(evaluation.outcome).toBe('allow');
    });

    it('never offer "always allow this site" there', () => {
      expect(evaluateBrowserGate(facts({ siteVerdict: 'high-risk' })).ask?.offersPersistentGrant)
        .toBe(false);
    });

    it('leave an attended READ alone — a screenshot of a bank page is not a transfer', () => {
      const evaluation = evaluateBrowserGate(facts({
        opClass: 'read-only',
        siteVerdict: 'high-risk',
      }));
      expect(evaluation.outcome).toBe('allow');
      expect(evaluation.ask).toBeNull();
    });
  });

  describe('attended runs', () => {
    // The gate resolves no origin for this path, so a blocked site is still
    // readable while the user is here and a bank page does not prompt on a
    // screenshot. Both are deliberate; the preview has to show them.
    it('read-only ignores the site verdict entirely', () => {
      for (const siteVerdict of ['denied', 'high-risk', 'allowed', 'default'] as const) {
        const evaluation = evaluateBrowserGate(facts({ opClass: 'read-only', siteVerdict }));
        expect(evaluation.outcome).toBe('allow');
        expect(evaluation.ask).toBeNull();
      }
    });

    it('read-only set to 「每次询问」 asks in a dialog with no standing-grant offer', () => {
      const evaluation = evaluateBrowserGate(facts({
        opClass: 'read-only',
        policy: { ...ALL_ALLOW, readOnly: 'ask' },
      }));
      expect(evaluation.ask).toEqual({
        channel: 'dialog',
        offersPersistentGrant: false,
        refusedReason: 'user-cancelled',
      });
    });

    it('let a click through silently on an "always allow" site', () => {
      const evaluation = evaluateBrowserGate(facts());
      expect(evaluation.outcome).toBe('allow');
      expect(evaluation.ask).toBeNull();
      expect(evaluation.intermediates.granted).toBe(true);
    });

    it('ask on a site with no standing verdict, offering to remember it', () => {
      const evaluation = evaluateBrowserGate(facts({ siteVerdict: 'default' }));
      expect(evaluation.ask?.channel).toBe('dialog');
      expect(evaluation.ask?.offersPersistentGrant).toBe(true);
    });

    it('honour the 30-minute conversation grant', () => {
      const evaluation = evaluateBrowserGate(facts({
        siteVerdict: 'default',
        conversationGrant: true,
      }));
      expect(evaluation.ask).toBeNull();
      expect(evaluation.outcome).toBe('allow');
    });

    // F8 — 「每次询问」 means every time: it honours neither the standing site
    // verdict nor the conversation grant, and offers no new one.
    it('ask every time when the row says so, whatever grants exist', () => {
      const evaluation = evaluateBrowserGate(facts({
        policy: { ...ALL_ALLOW, interactive: 'ask' },
        siteVerdict: 'allowed',
        conversationGrant: true,
      }));
      expect(evaluation.ask?.channel).toBe('dialog');
      expect(evaluation.ask?.offersPersistentGrant).toBe(false);
      expect(evaluation.intermediates.asksEveryTime).toBe(true);
    });

    it('refuse rather than act silently when no confirmation could be delivered', () => {
      const evaluation = evaluateBrowserGate(facts({
        siteVerdict: 'default',
        confirmationChannelAvailable: false,
      }));
      expect(evaluation.outcome).toBe('deny');
      expect(evaluation.denialReason).toBe('approval-refused');
    });

    describe('scripting', () => {
      it('rides neither grant scope — only the row\'s own allow on an allowed site', () => {
        expect(evaluateBrowserGate(facts({
          opClass: 'scripting',
          siteVerdict: 'default',
          conversationGrant: true,
        })).ask?.channel).toBe('dialog');
        const scoped = evaluateBrowserGate(facts({ opClass: 'scripting' }));
        expect(scoped.ask).toBeNull();
        expect(scoped.intermediates.scriptAllowedByPolicy).toBe(true);
      });

      it('never offers "always allow this site"', () => {
        expect(evaluateBrowserGate(facts({
          opClass: 'scripting',
          siteVerdict: 'default',
        })).ask?.offersPersistentGrant).toBe(false);
      });
    });

    describe('answering a page\'s own dialog', () => {
      it('rides neither grant scope either', () => {
        expect(evaluateBrowserGate(facts({
          answersPageDialog: true,
          siteVerdict: 'default',
          conversationGrant: true,
        })).ask?.channel).toBe('dialog');
        const scoped = evaluateBrowserGate(facts({ answersPageDialog: true }));
        expect(scoped.ask).toBeNull();
        expect(scoped.intermediates.dialogAnswerAllowedByPolicy).toBe(true);
      });
    });
  });

  it('offers no standing grant when the origin is unknown — there is no key to store it under', () => {
    expect(evaluateBrowserGate(facts({ siteVerdict: 'default', originKnown: false }))
      .ask?.offersPersistentGrant).toBe(false);
  });

  it('refuses a configured deny before anything else can soften it', () => {
    const evaluation = evaluateBrowserGate(facts({
      policy: { ...DEFAULT_BROWSER_OPERATION_POLICY, interactive: 'deny' },
      siteVerdict: 'allowed',
      conversationGrant: true,
    }));
    expect(evaluation.outcome).toBe('deny');
    expect(evaluation.denialReason).toBe('policy-denied');
  });
});
