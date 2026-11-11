/** Why a URL was classified high-risk. Surfaced in the refusal/confirmation copy. */
export type HighRiskReason = 'money-domain' | 'government-domain';

export interface HighRiskSiteMatch {
  reason: HighRiskReason;
  /** The host suffix or path keyword that matched — for logs and copy, never for control flow. */
  matched: string;
}

export function classifyHighRiskUrl(url: string | null | undefined): HighRiskSiteMatch | null;
export function isHighRiskUrl(url: string | null | undefined): boolean;
/** Money-movement keyword in the path; only Electron's popup policy uses it. */
export function hasMoneyMovementPath(url: string | null | undefined): boolean;
