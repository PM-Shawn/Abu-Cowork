/**
 * The browser authorization gate, as a pure function.
 *
 * ## Why this module exists
 *
 * S12 asks Settings to answer "what can Abu do on this site right now?" without
 * doing anything — no tool call, no page fetch, no message, no grant. There are
 * only two ways to build that: re-derive the rules in the UI, or share the ones
 * the gate already uses. The first is a second source of truth for the most
 * consequential decision in this app, and a preview that quietly disagrees with
 * the gate is worse than no preview at all — it would teach the user a model of
 * their own settings that is wrong. So `registry.ts`'s gate and the preview
 * call THIS, and `browserGateEvaluation.contract.test.ts` runs the real gate
 * (`checkToolApproval`) against this function over the whole matrix to prove
 * they never disagree.
 *
 * `decideBrowserOperation` (browserToolPolicy.ts) was already pure, but it is
 * only the policy ROW: it knows nothing about the run-permission ceiling, the
 * unverifiable origin, the login wall, the standing-grant requirement for
 * unattended actions, the conversation grant, or which of the three ask sites
 * would carry the question. Those rules lived inline in `checkToolApproval`,
 * interleaved with the signal recording and the approval round-trips they gate.
 * This module is those rules, and nothing else.
 *
 * ## What this module is NOT
 *
 * It does no I/O and holds no state. It does not resolve an origin, classify a
 * URL's risk, read settings, or ask anyone anything — those all happen in the
 * caller, which passes the results in as facts. That is what makes the same
 * function safe to call from a settings pane: the preview supplies facts it can
 * know statically and gets a verdict, and nothing observable happens.
 *
 * It also does not decide what a refusal SAYS. The reason codes are a closed
 * vocabulary (`BrowserDenialReasonCode`); `browserDenialReasonText.ts` turns one
 * into a sentence, and both the gate and the preview use that one mapping.
 */

import {
  decideBrowserOperation,
  type BrowserDenialReasonCode,
  type BrowserOperationClass,
  type BrowserOperationPolicy,
  type DecideBrowserOperationSiteVerdict,
} from './browserToolPolicy';
import { getPermissionStrategy, type PermissionMode } from './permissionMode';
import {
  decideStateChangingToolUnderRunPermissionCeiling,
  type CeilingDecision,
  type RunPermissionCeiling,
} from './runPermissionCeiling';

/** Where the confirmation would be put to a human. */
export type BrowserGateAskChannel = 'dialog' | 'im';

export interface BrowserGateAsk {
  /**
   * `'dialog'` — the in-app confirmation, for a run with somebody watching.
   * `'im'` — the unattended approval round-trip, which reaches whoever the
   * automation itself named. Which specific person that is depends on the
   * automation's own IM binding, which this function deliberately knows
   * nothing about (see S11: approval binding is task-owned, not global).
   */
  channel: BrowserGateAskChannel;
  /** Whether the confirmation may also offer 「以后都允许该网站」. */
  offersPersistentGrant: boolean;
  /** The code to report if the human refuses, or nobody answers in time. */
  refusedReason: BrowserDenialReasonCode;
}

/**
 * Intermediates `registry.ts` needs for bookkeeping that is NOT part of the
 * decision — minting the conversation grant, and classifying an allow for U4's
 * consecutive-denial streak. They are returned rather than recomputed at the
 * call site so the two can never drift out of step with the decision they were
 * derived alongside.
 */
export interface BrowserGateIntermediates {
  /** Attended: the scripting row's own 'allow', scoped to a 「始终允许」 site. */
  scriptAllowedByPolicy: boolean;
  /** Attended: the same rule for answering a page's own dialog. */
  dialogAnswerAllowedByPolicy: boolean;
  /** Attended: an interactive/read-only row the user set to 「每次询问」. */
  asksEveryTime: boolean;
  /** Attended state-changing: the call was already covered by a standing grant. */
  granted: boolean;
}

export interface BrowserGateEvaluation {
  /**
   * The outcome ASSUMING every confirmation in `ask` is approved.
   *
   * `'allow'` with `ask === null` is a silent allow; `'allow'` with an `ask` is
   * 「会询问」. `'deny'` with an `ask` is real and reachable — an unattended
   * 「每次询问」 on a site with no standing grant asks a human and is refused
   * anyway (see `evaluateBrowserGate`'s unattended branch) — so a caller that
   * only reads `outcome` still gets the right answer.
   */
  outcome: 'allow' | 'deny';
  /** Set exactly when `outcome === 'deny'`. */
  denialReason: BrowserDenialReasonCode | null;
  /** Set when a human is asked before `outcome` is reached. */
  ask: BrowserGateAsk | null;
  /**
   * Non-null exactly when the refusal came from the run's CAPABILITY CEILING
   * rather than from the browser configuration.
   *
   * The ceiling's own reason is a hardcoded English diagnostic aimed at the
   * model and the tool result, and `registry.ts` returns it verbatim there
   * while giving the user-facing notice the localized sentence. Both surfaces
   * need what they need, so the ceiling's decision travels alongside the code
   * instead of being flattened into it.
   */
  ceilingDecision: CeilingDecision | null;
  intermediates: BrowserGateIntermediates;
}

export interface BrowserGateFacts {
  /** Read-only / interactive / scripting — for a batch, its heaviest step. */
  opClass: BrowserOperationClass;
  /** The execution context, not a second policy axis (see `DecideBrowserOperationInput`). */
  runMode: 'attended' | 'unattended';
  policy: BrowserOperationPolicy;
  /** `allowUnattendedBrowser` — the global switch for automatic browser use. */
  masterSwitchUnattended: boolean;
  /** The stored verdict, with `'high-risk'` already substituted by the caller. */
  siteVerdict: DecideBrowserOperationSiteVerdict;
  /** The user's global permission mode. Reads through `getPermissionStrategy`
   *  rather than being assumed, so a future mode that treats the browser
   *  differently changes the gate and the preview in the same edit. */
  permissionMode: PermissionMode;
  /** The run's host-owned capability ceiling, or null for an ordinary chat turn. */
  runPermissionCeiling: RunPermissionCeiling | null;
  /**
   * Whether the tool acts on a page at all. `get_tabs` / `connection_status` /
   * `get_downloads` do not, so an unresolvable origin is not a refusal for
   * them — there is no site behind them to verify.
   */
  toolTargetsPage: boolean;
  /** Whether the origin was actually resolved. Only consulted unattended. */
  originResolved: boolean;
  /** Whether the tool ANSWERS a page's own dialog (`handle_dialog`). */
  answersPageDialog: boolean;
  /** The host observed a sign-in wall. Advisory: only ever used to REFUSE. */
  loginRequired: boolean;
  /**
   * The 30-minute per-conversation grant minted by an earlier dialog.
   *
   * The preview passes `false` always — a session grant is not a setting, and
   * reporting 「允许」 because one happens to be live would answer a question
   * about configuration with an accident of the last half hour.
   */
  conversationGrant: boolean;
  /**
   * Whether a confirmation could actually be delivered at all. `registry.ts`
   * passes whether it was handed an `onRequireConfirmation`; with none, an ask
   * fails closed rather than acting silently in the user's session.
   */
  confirmationChannelAvailable: boolean;
  /** Whether the origin is known, which is what a persistent grant is keyed by. */
  originKnown: boolean;
}

function denied(
  denialReason: BrowserDenialReasonCode,
  intermediates: BrowserGateIntermediates,
  ask: BrowserGateAsk | null = null,
  ceilingDecision: CeilingDecision | null = null,
): BrowserGateEvaluation {
  return { outcome: 'deny', denialReason, ask, ceilingDecision, intermediates };
}

function allowed(
  intermediates: BrowserGateIntermediates,
  ask: BrowserGateAsk | null = null,
): BrowserGateEvaluation {
  return { outcome: 'allow', denialReason: null, ask, ceilingDecision: null, intermediates };
}

const NO_INTERMEDIATES: BrowserGateIntermediates = {
  scriptAllowedByPolicy: false,
  dialogAnswerAllowedByPolicy: false,
  asksEveryTime: false,
  granted: false,
};

/**
 * Evaluate one browser operation against the current configuration.
 *
 * The order below is `checkToolApproval`'s own, preserved exactly — including
 * the one sequence that looks wrong and is not being changed here: an
 * unattended 「每次询问」 on a site with NO standing grant asks a human first
 * and is then refused by the standing-grant rule regardless of the answer. That
 * is what ships today; this function reports it faithfully (`ask` set,
 * `outcome: 'deny'`) rather than quietly improving it, because the whole value
 * of this module is that it says what the gate does.
 */
export function evaluateBrowserGate(facts: BrowserGateFacts): BrowserGateEvaluation {
  const {
    opClass,
    runMode,
    policy,
    masterSwitchUnattended,
    siteVerdict,
    permissionMode,
    runPermissionCeiling,
    toolTargetsPage,
    originResolved,
    answersPageDialog,
    loginRequired,
    conversationGrant,
    confirmationChannelAvailable,
    originKnown,
  } = facts;

  const stateChanging = opClass !== 'read-only';
  const scripting = opClass === 'scripting';

  /**
   * An ATTENDED READ-ONLY call reads exactly one thing out of the site
   * verdict: whether the user BLOCKED this site. Nothing else.
   *
   * A block is the one verdict that is not about acting. 「这个网站一律不操作，
   * 包括自动任务」 is what the site card promises, `filterDownloadsByOrigin`
   * already honours it in both run modes ("a blocked site is blocked in both
   * run modes"), and a screenshot of a site the user blocked is precisely the
   * page they said they did not want Abu on. The preview used to report
   * 「允许」 for that cell while the card two rows up said 「一律不操作」 —
   * the same settings screen contradicting itself.
   *
   * The other three verdicts stay out of this path, and that is still a rule
   * rather than an oversight: a bank page must not force a confirmation on a
   * screenshot, and 「始终允许」 buys nothing a read did not already have. So
   * `'high-risk'` and `'allowed'` collapse to `'default'` here exactly as
   * before, and `highRisk` below stays false for an attended read.
   *
   * `registry.ts` pays for this narrowly: it resolves an origin for an
   * attended read ONLY when the site table actually contains a block, so a
   * user who has never blocked anything keeps the shipped path byte for byte
   * (`registry.operationPolicy.test.ts` pins that). When the origin cannot be
   * resolved the verdict arrives as `'default'` and the read proceeds — the
   * gate does not fail closed on a read a human is watching — and the gate
   * records a signal so the silence is observable.
   *
   * Stated here rather than left implicit in what the caller happens to pass,
   * so the preview shows the same thing without having to know how the gate
   * gathers its facts. The contract test pins the two together either way.
   */
  const consultsSite = stateChanging || runMode === 'unattended';
  const effectiveSiteVerdict: DecideBrowserOperationSiteVerdict = consultsSite
    ? siteVerdict
    : siteVerdict === 'denied' ? 'denied' : 'default';
  const highRisk = effectiveSiteVerdict === 'high-risk';

  const policyVerdict = decideBrowserOperation({
    opClass,
    runMode,
    policy,
    masterSwitchUnattended,
    siteVerdict: effectiveSiteVerdict,
  });

  /**
   * The most specific true reason for an unattended refusal, in the gate's own
   * precedence order. Kept as a function (not a value) because the
   * standing-grant branch re-asks `decideBrowserOperation` with an allowed
   * site, which is how the gate avoids keeping a second copy of that rule.
   */
  const unattendedDenialCode = (): BrowserDenialReasonCode => {
    if (!masterSwitchUnattended) return 'master-switch-off';
    if (effectiveSiteVerdict === 'denied') return 'site-denied';
    if (highRisk) return 'high-risk-site';
    if (
      policyVerdict === 'deny'
      && effectiveSiteVerdict !== 'allowed'
      && decideBrowserOperation({
        opClass,
        runMode,
        policy,
        masterSwitchUnattended,
        siteVerdict: 'allowed',
      }) === 'allow'
    ) {
      return 'site-not-allowed';
    }
    if (policyVerdict === 'deny') return 'policy-denied';
    return 'capability-denied';
  };

  // 1. The run's capability ceiling. Only state-changing calls are ceiling-
  //    checked, matching the gate.
  if (stateChanging) {
    const ceilingDecision = decideStateChangingToolUnderRunPermissionCeiling(
      runPermissionCeiling,
      'browser',
      policyVerdict,
    );
    if (ceilingDecision.decision === 'deny') {
      return denied(
        runMode === 'unattended' ? unattendedDenialCode() : 'capability-denied',
        NO_INTERMEDIATES,
        null,
        ceilingDecision,
      );
    }
  }

  // 2. A site the user blocked stays blocked — for reads too, whether or not
  //    anybody is watching.
  if (effectiveSiteVerdict === 'denied') {
    return denied(
      runMode === 'unattended' ? unattendedDenialCode() : 'site-denied',
      NO_INTERMEDIATES,
    );
  }

  // 3. The configured row says no.
  if (policyVerdict === 'deny') {
    return denied(
      runMode === 'unattended' ? unattendedDenialCode() : 'policy-denied',
      NO_INTERMEDIATES,
    );
  }

  if (runMode === 'unattended') {
    // 4a. An origin the host could not resolve. Without this a wedged browser
    //     host would resolve every origin to null, every verdict to 'default',
    //     and an unattended run could read a site the user explicitly blocked.
    if (toolTargetsPage && !originResolved) {
      return denied('origin-unverified', NO_INTERMEDIATES);
    }
    // 4b. An expired session with nobody here to sign in. Scoped to
    //     state-changing on purpose: reading the login wall is how the run
    //     learns to hand back.
    if (loginRequired && stateChanging) {
      return denied('login-required', NO_INTERMEDIATES);
    }

    const ask: BrowserGateAsk | null = policyVerdict === 'ask'
      ? { channel: 'im', offersPersistentGrant: false, refusedReason: 'approval-refused' }
      : null;

    // 4d. Cross-origin fail-closed baseline. Runs AFTER the ask, exactly as the
    //     gate does — see this function's doc comment.
    if (stateChanging && effectiveSiteVerdict !== 'allowed') {
      return denied('site-not-allowed', NO_INTERMEDIATES, ask);
    }
    return allowed(NO_INTERMEDIATES, ask);
  }

  if (stateChanging) {
    // Attended, state-changing: the shipped per-site + permission-mode gate.
    const scriptAllowedByPolicy =
      scripting && !highRisk && policyVerdict === 'allow' && effectiveSiteVerdict === 'allowed';
    const dialogAnswerAllowedByPolicy =
      answersPageDialog && !highRisk && policyVerdict === 'allow' && effectiveSiteVerdict === 'allowed';
    const asksEveryTime = !scripting && policyVerdict === 'ask';
    const granted =
      scriptAllowedByPolicy
      || dialogAnswerAllowedByPolicy
      || (!scripting && !answersPageDialog && !highRisk && !asksEveryTime
        && (conversationGrant || effectiveSiteVerdict === 'allowed'));
    const intermediates: BrowserGateIntermediates = {
      scriptAllowedByPolicy,
      dialogAnswerAllowedByPolicy,
      asksEveryTime,
      granted,
    };

    const decision = getPermissionStrategy(permissionMode)
      .decideOtherTool('state-changing', granted);
    if (decision === 'allow') return allowed(intermediates);
    if (!confirmationChannelAvailable) {
      return denied('approval-refused', intermediates);
    }
    return allowed(intermediates, {
      channel: 'dialog',
      // No 「以后都允许该网站」 for a bank or a checkout page, none under
      // 「每次询问」 (the grant it would mint is one this row now ignores),
      // none for a script, and none without an origin to key it to.
      offersPersistentGrant: !scripting && !highRisk && !asksEveryTime && originKnown,
      refusedReason: 'user-cancelled',
    });
  }

  // Attended read-only explicitly configured to ask. Never reached under the
  // shipped default, but the setting has to do something when a user picks it.
  if (policyVerdict === 'ask') {
    if (!confirmationChannelAvailable) {
      return denied('approval-refused', NO_INTERMEDIATES);
    }
    return allowed(NO_INTERMEDIATES, {
      channel: 'dialog',
      offersPersistentGrant: false,
      refusedReason: 'user-cancelled',
    });
  }

  return allowed(NO_INTERMEDIATES);
}

/** What the preview reports for one cell: allow / ask / deny. */
export type BrowserGatePreviewVerdict = 'allow' | 'ask' | 'deny';

/**
 * Collapse an evaluation into the three words a person reads.
 *
 * `deny` wins over `ask`: an evaluation that asks and then refuses anyway is a
 * refusal, and telling the user 「会询问」 there would promise a road that does
 * not exist.
 */
export function browserGatePreviewVerdict(
  evaluation: BrowserGateEvaluation,
): BrowserGatePreviewVerdict {
  if (evaluation.outcome === 'deny') return 'deny';
  return evaluation.ask === null ? 'allow' : 'ask';
}
