/**
 * The ONE code → copy table for an unattended run's browser facts.
 *
 * Two surfaces read the same run: the report card a person opens in the
 * morning, and the IM summary that reaches them wherever they actually are at
 * 9am. Before F7 the card owned these switches privately, so the only way to
 * say "site not authorized" in IM was to write a second sentence for the same
 * code — two tables, one fact, guaranteed to drift the first time a reason
 * code is renamed.
 *
 * Codes in, sentences out, and never the reverse: the persisted snapshot
 * stores CODES (`browserRunReport.ts`, Ruling on `BrowserRunReportNextStep`),
 * so a user who switches the app to English is not left with a Chinese card
 * frozen into their history — and the IM summary, built at push time from the
 * same codes, follows the same rule.
 *
 * `t` is passed in rather than read from a module singleton so both callers
 * stay pure functions of (code, dict): the card renders with `useI18n()`, the
 * push path with `getI18n()`, and the tests with neither.
 */
import type { TranslationDict } from '../../i18n';
import type { BrowserDenialReasonCode } from '../permissions/browserToolPolicy';
import type { BrowserRunReportNextStep } from './browserRunReport';

/**
 * What a label falls back to when a snapshot carries a code this build does
 * not know — a card written by a newer version and read back after a
 * downgrade, or a code that has since been renamed.
 *
 * The switches below stay EXHAUSTIVE over their unions: the `never` parameter
 * makes adding a union member without a case a compile error, so a new denial
 * reason still cannot ship without its translation. This only handles the
 * runtime case the type system cannot see — a value that came off disk.
 *
 * It returns the raw code rather than nothing. A blank reason row, an empty
 * next-step bullet or an unlabelled badge is the "it did nothing" failure
 * these surfaces exist to prevent; an ugly `site-throttled` is still an
 * answer.
 */
export function rawCode(value: never): string {
  return String(value);
}

/** Short label per denial reason code. */
export function reasonLabel(reason: BrowserDenialReasonCode, t: TranslationDict): string {
  const r = t.browserRunReport.reason;
  switch (reason) {
    case 'master-switch-off': return r.masterSwitchOff;
    case 'site-denied': return r.siteDenied;
    case 'high-risk-site': return r.highRiskSite;
    case 'policy-denied': return r.policyDenied;
    case 'enterprise-policy-denied': return r.enterprisePolicyDenied;
    case 'capability-denied': return r.capabilityDenied;
    case 'origin-unverified': return r.originUnverified;
    case 'login-required': return r.loginRequired;
    case 'site-not-allowed': return r.siteNotAllowed;
    case 'approval-refused': return r.approvalRefused;
    case 'user-cancelled': return r.userCancelled;
  }
  return rawCode(reason);
}

/** The actionable instruction per next-step code. */
export function stepLabel(step: BrowserRunReportNextStep, t: TranslationDict): string {
  const s = t.browserRunReport.step;
  switch (step) {
    case 'enable-master-switch': return s.enableMasterSwitch;
    case 'allow-site': return s.allowSite;
    case 'unblock-site': return s.unblockSite;
    case 'do-high-risk-yourself': return s.doHighRiskYourself;
    case 'sign-in-then-rerun': return s.signInThenRerun;
    case 'relax-policy': return s.relaxPolicy;
    case 'raise-capability': return s.raiseCapability;
    case 'answer-approval': return s.answerApproval;
    case 'run-while-watching': return s.runWhileWatching;
  }
  return rawCode(step);
}
