import { isHighRiskUrl } from './highRiskSites';

/**
 * "Which sites can a run without me act on?" — answered once, for every screen
 * that asks it (U5 authorization visibility).
 *
 * The facts were all there before: the master switch and the per-site verdicts
 * live in settingsStore, and the gate reads them on every call. What was
 * missing was anywhere a user could SEE the answer. Settings showed a list of
 * site verdicts with no hint that "allowed" is also what an unattended task
 * runs on, and a scheduled task's detail page had no permission UI at all — so
 * the standing authorization a nightly task acts under was invisible right
 * where someone would look for it.
 *
 * Pure and store-free on purpose: components pass the two settings values in,
 * which keeps this unit-testable and keeps the calculation identical on both
 * screens (two hand-rolled filters would drift, and a UI that under-reports
 * authorization is worse than no UI at all).
 */
export interface BrowserAuthorizationSummary {
  /** `allowUnattendedBrowser`. With it off, `reachableUnattended` is empty. */
  masterSwitchOn: boolean;
  /**
   * Origins an unattended run may act on: an `'allowed'` verdict, the master
   * switch on, and not high-risk.
   */
  reachableUnattended: string[];
  /**
   * Origins the user marked `'allowed'` that `highRiskSites.ts` classifies as
   * money movement / government anyway. They are NOT unattended-reachable — the
   * gate refuses there whatever the verdict says — and attended they always
   * ask. Surfaced separately so the list does not silently look shorter than
   * the user's own settings.
   */
  highRiskAllowed: string[];
  /** Origins with a `'denied'` verdict — blocked in both run modes. */
  blocked: string[];
}

export function summarizeBrowserAuthorization(
  sitePermissions: Record<string, 'allowed' | 'denied'> | undefined,
  allowUnattendedBrowser: boolean | undefined,
): BrowserAuthorizationSummary {
  const masterSwitchOn = allowUnattendedBrowser === true;
  const reachableUnattended: string[] = [];
  const highRiskAllowed: string[] = [];
  const blocked: string[] = [];

  for (const origin of Object.keys(sitePermissions ?? {}).sort()) {
    const verdict = sitePermissions?.[origin];
    if (verdict === 'denied') {
      blocked.push(origin);
      continue;
    }
    if (verdict !== 'allowed') continue;
    // The classifier reads a URL; an origin IS one, and a bank's whole origin
    // is high-risk regardless of path. A per-path verdict is decided per call
    // at the gate — this only reports what is knowable from the stored key.
    if (isHighRiskUrl(origin)) {
      highRiskAllowed.push(origin);
      continue;
    }
    if (masterSwitchOn) reachableUnattended.push(origin);
  }

  return { masterSwitchOn, reachableUnattended, highRiskAllowed, blocked };
}
