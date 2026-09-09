import { format } from '@/i18n';
import type { TranslationDict } from '@/i18n/types';
import type { BrowserDenialReasonCode } from './browserToolPolicy';
import {
  formatBytes,
  MAX_UPLOAD_FILE_BYTES,
  MAX_UPLOAD_FILES,
  type BrowserUploadRefusalCode,
} from './browserUploadFiles';

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
    case 'server-disabled': return t.commandConfirm.browserServerDisabled;
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

/**
 * The same seam for an upload's OWN refusals (T5).
 *
 * These are not `BrowserDenialReasonCode`s and deliberately do not become
 * ones: every member of that union is a decision about whether Abu may act on
 * a SITE, and the next step it implies ("authorize the site", "loosen the
 * policy", "run it while watching") is wrong for all six of these. They are
 * facts about a FILE — it is not there, it is a link, it is too big, it is
 * outside what the user authorized — and each carries its own next step.
 *
 * Exhaustive by construction, same as above.
 */
export function browserUploadRefusalText(
  t: TranslationDict,
  code: BrowserUploadRefusalCode,
  detail?: string,
): string {
  const name = detail ?? '';
  switch (code) {
    case 'malformed': return t.commandConfirm.browserUploadMalformed;
    case 'too-many-files':
      return format(t.commandConfirm.browserUploadTooManyFiles, { max: MAX_UPLOAD_FILES });
    case 'not-authorized':
      return format(t.commandConfirm.browserUploadNotAuthorized, { name });
    case 'not-a-file':
      return format(t.commandConfirm.browserUploadNotAFile, { name });
    case 'symlink':
      return format(t.commandConfirm.browserUploadSymlink, { name });
    case 'too-large':
      return format(t.commandConfirm.browserUploadTooLarge, {
        name,
        max: formatBytes(MAX_UPLOAD_FILE_BYTES),
      });
    case 'unidentifiable':
      return format(t.commandConfirm.browserUploadUnidentifiable, { name });
  }
}
