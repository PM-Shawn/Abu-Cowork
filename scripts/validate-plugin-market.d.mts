/**
 * Declarations for `validate-plugin-market.mjs`'s exported check functions,
 * so `validate-plugin-market.test.ts` imports them typed. The CLI entry point
 * is not meant to be imported.
 */

export class MarketCheckFailure {
  entry: string;
  message: string;
  field?: string;
  toString(): string;
}

export interface MarketCheckEntry {
  name: string;
  version?: string;
  providesApp?: unknown;
  minAbuVersion?: unknown;
  source: { kind: 'relative'; path: string } | { kind: 'url'; url: string; sha?: string } | { kind: 'git-subdir'; url: string; path: string; ref?: string; sha?: string };
}

export interface MarketCheckResult {
  marketplace: string;
  file: string;
  checked: { name: string; packageDir: string; providesApp: boolean }[];
  failures: MarketCheckFailure[];
}

export function checkPackage(packageDir: string, entry: MarketCheckEntry, options: { hostVersion: string }): MarketCheckFailure[];
export function checkMarket(marketDir: string, options: { hostVersion: string; stagingRoot?: string }): Promise<MarketCheckResult>;
