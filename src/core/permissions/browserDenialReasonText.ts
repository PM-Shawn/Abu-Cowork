import type { TranslationDict } from '@/i18n/types';
import type { BrowserDenialReasonCode } from './browserToolPolicy';

/**
 * The one place a browser denial code becomes words.
 *
 * `BrowserDenialReasonCode` is a closed, locale-independent vocabulary shared
 * by every consumer that has to explain a refusal — the sentence in a run
 * result, the observability signal, the unattended report card, and (S12) the
 * settings preview. Codes aggregate; sentences read. This function is the seam
 * between the two, extracted from `registry.ts`'s local closure so the preview
 * cannot answer 「为什么」 with different words than the gate does for the same
 * cause.
 *
 * Exhaustive by construction: the switch has no `default`, so adding a code
 * without adding its sentence is a compile error rather than an empty line in
 * front of a user.
 */
export function browserDenialReasonText(
  t: TranslationDict,
  reason: BrowserDenialReasonCode,
): string {
  switch (reason) {
    case 'master-switch-off': return t.commandConfirm.browserUnattendedDisabled;
    case 'site-denied': return t.commandConfirm.browserSiteDenied;
    case 'high-risk-site': return t.commandConfirm.browserUnattendedHighRiskSite;
    case 'policy-denied': return t.commandConfirm.browserPolicyDenied;
    case 'enterprise-policy-denied': return t.commandConfirm.browserEnterprisePolicyDenied;
    case 'capability-denied': return t.commandConfirm.browserUnattendedCapabilityDenied;
    case 'origin-unverified': return t.commandConfirm.browserUnattendedOriginUnverified;
    case 'login-required': return t.commandConfirm.browserUnattendedLoginRequired;
    case 'site-not-allowed': return t.commandConfirm.browserUnattendedSiteNotAllowed;
    case 'approval-refused': return t.commandConfirm.browserUnattendedConfirmUnavailable;
    case 'user-cancelled': return t.commandConfirm.userCancelled;
  }
}
