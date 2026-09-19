import { isHighRiskUrl } from '@/core/permissions/highRiskSites';
import { normalizeBrowserOrigin } from '@/core/permissions/browserToolPolicy';
type BrowserSitePermissionVerdict = 'allowed' | 'denied';

export type BrowserSitePermissionDraftIssue =
  | 'empty'
  | 'invalid'
  | 'credentials'
  | 'high-risk'
  | 'duplicate';

export interface BrowserSitePermissionDraftAnalysis {
  issue: BrowserSitePermissionDraftIssue | null;
  normalizedOrigin: string | null;
  existingVerdict: BrowserSitePermissionVerdict | undefined;
  changesExisting: boolean;
}

/**
 * Analyze the inline site draft without creating another origin normalizer.
 * URL parsing here has two narrow jobs the official normalizer intentionally
 * does not have: reject embedded credentials before they are stripped, and
 * retain the full input for path-level high-risk classification.
 */
export function analyzeBrowserSitePermissionDraft(
  rawUrl: string,
  verdict: BrowserSitePermissionVerdict,
  existingPermissions: Record<string, BrowserSitePermissionVerdict>,
): BrowserSitePermissionDraftAnalysis {
  const trimmed = rawUrl.trim();
  if (trimmed === '') {
    return {
      issue: 'empty',
      normalizedOrigin: null,
      existingVerdict: undefined,
      changesExisting: false,
    };
  }

  // Malformed URLs with an explicit user-info separator can fail URL parsing.
  // Recognize that narrow sensitive shape first so the caller can clear it.
  if (/^[a-z][a-z\d+.-]*:\/\/[^/?#]*@/i.test(trimmed)) {
    return {
      issue: 'credentials',
      normalizedOrigin: null,
      existingVerdict: undefined,
      changesExisting: false,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      issue: 'invalid',
      normalizedOrigin: null,
      existingVerdict: undefined,
      changesExisting: false,
    };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return {
      issue: 'credentials',
      normalizedOrigin: null,
      existingVerdict: undefined,
      changesExisting: false,
    };
  }

  const normalizedOrigin = normalizeBrowserOrigin(trimmed);
  if (normalizedOrigin === null) {
    return {
      issue: 'invalid',
      normalizedOrigin: null,
      existingVerdict: undefined,
      changesExisting: false,
    };
  }

  const existingVerdict = existingPermissions[normalizedOrigin];
  // Equality comes before the high-risk refusal. A legacy allowed grant that
  // is classified high-risk today remains visible but constrained; submitting
  // the same value must be a zero-write duplicate, especially when its
  // via-embed mark would otherwise be cleared by a direct store write.
  if (existingVerdict === verdict) {
    return {
      issue: 'duplicate',
      normalizedOrigin,
      existingVerdict,
      changesExisting: false,
    };
  }
  if (
    verdict === 'allowed'
    && (isHighRiskUrl(trimmed) || isHighRiskUrl(normalizedOrigin))
  ) {
    return {
      issue: 'high-risk',
      normalizedOrigin,
      existingVerdict,
      changesExisting: existingVerdict !== undefined,
    };
  }

  return {
    issue: null,
    normalizedOrigin,
    existingVerdict,
    changesExisting: existingVerdict !== undefined,
  };
}
