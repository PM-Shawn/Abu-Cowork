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

type EntrySource = { kind: 'relative'; path: string } | { kind: 'url'; url: string; sha?: string } | { kind: 'git-subdir'; url: string; path: string; ref?: string; sha?: string };

export interface MarketCheckEntry {
  name: string;
  version?: string;
  minAbuVersion?: unknown;
  source: EntrySource;
}

export interface PluginShips {
  teamIds: Set<string>;
  agentNames: Set<string>;
  skillNames: Set<string>;
  mcpServerNames: Set<string>;
}

export interface MarketCheckResult {
  marketplace: string;
  file: string;
  checked: { kind: 'plugin' | 'app'; name: string; dir: string }[];
  failures: MarketCheckFailure[];
}

export function checkPackage(packageDir: string, entry: MarketCheckEntry, options: { hostVersion: string }): { failures: MarketCheckFailure[]; ships?: PluginShips };
export function checkApp(appDir: string, entry: { name: string; version?: string; minAbuVersion?: string }, options: { hostVersion: string; pluginsByName: Map<string, PluginShips> }): MarketCheckFailure[];
export function checkMarket(marketDir: string, options: { hostVersion: string; stagingRoot?: string }): Promise<MarketCheckResult>;
