import { describe, it, expect } from 'vitest';

import { isAuthoredInstall, isSelfAuthoredPlugin, orphanedInstalls } from './authored';
import { BUILTIN_MARKET_NAME } from './builtinMarket';
import { ENTERPRISE_MARKET_NAME } from './enterpriseMarket';
import type { InstalledPlugin } from './installedStore';

function makePlugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    key: 'foo@mkt',
    marketplace: 'mkt',
    name: 'foo',
    version: '1.0.0',
    installedAt: '2026-09-04T00:00:00.000Z',
    contributed: { skills: [], mcpServers: [] },
    ...overrides,
  };
}

describe('isSelfAuthoredPlugin', () => {
  it.each([
    { marketplace: 'agent-market', sourceKind: 'relative' as const },
    { marketplace: 'my-market', sourceKind: 'relative' as const, sha: 'abc123' },
    { marketplace: 'my-market', sourceKind: 'url' as const },
    { marketplace: 'my-market', sourceKind: 'git-subdir' as const, sha: 'abc123' },
    { marketplace: 'legacy-market' },
    { marketplace: 'legacy-market', sha: 'abc123' },
    { marketplace: BUILTIN_MARKET_NAME, sourceKind: 'relative' as const },
    { marketplace: ENTERPRISE_MARKET_NAME, sourceKind: 'relative' as const },
  ])('does not infer authorship from a market install: %j', (record) => {
    expect(isSelfAuthoredPlugin(makePlugin(record))).toBe(false);
  });
});

describe('orphanedInstalls', () => {
  it('returns installs whose marketplace is no longer in the list', () => {
    const kept = makePlugin({ key: 'kept@here', marketplace: 'here' });
    const orphan = makePlugin({ key: 'gone@removed', marketplace: 'removed' });
    expect(orphanedInstalls([kept, orphan], [{ name: 'here' }])).toEqual([orphan]);
  });

  it('never orphans an enterprise install — its market is not in the user list by design', () => {
    const org = makePlugin({ key: 'org@enterprise', marketplace: ENTERPRISE_MARKET_NAME });
    expect(orphanedInstalls([org], [{ name: 'here' }])).toEqual([]);
  });

  it('never orphans a built-in install, present in the list or not — the user cannot remove that market', () => {
    const builtin = makePlugin({ key: 'b@abu-official', marketplace: BUILTIN_MARKET_NAME });
    expect(orphanedInstalls([builtin], [{ name: BUILTIN_MARKET_NAME }])).toEqual([]);
    expect(orphanedInstalls([builtin], [{ name: 'here' }])).toEqual([]);
    expect(orphanedInstalls([builtin], [])).toEqual([]);
  });

  // Caller-owned caveat: this predicate cannot distinguish "the user has no markets"
  // from "markets have not loaded yet" — the caller must render the orphan group only
  // after the marketplace list has hydrated.
  it('orphans everything personal when the marketplace list is empty (caller must only ask after hydration)', () => {
    const a = makePlugin({ key: 'a@one', marketplace: 'one' });
    const b = makePlugin({ key: 'b@two', marketplace: 'two' });
    expect(orphanedInstalls([a, b], [])).toEqual([a, b]);
  });

  it('returns [] for an empty install list', () => {
    expect(orphanedInstalls([], [{ name: 'here' }])).toEqual([]);
  });
});

/**
 * Regression: orphanedInstalls exempted only the enterprise and built-in
 * markets, so a locally created plugin — whose synthesised `author-<id>`
 * marketplace is never in the user's market list — was reported as a market
 * plugin whose source had disappeared, labelled with the raw author id. The
 * page's join against the author store hid it, which meant one failed author
 * read relabelled everything the user had written.
 */
describe('isAuthoredInstall', () => {
  const authored = (over: Partial<InstalledPlugin> = {}) => makePlugin({
    key: 'mine@author-9f3c', name: 'mine', marketplace: 'author-9f3c',
    authoringId: '9f3c', ...over,
  });

  it('reads provenance off the record, not the author list', () => {
    expect(isAuthoredInstall(authored())).toBe(true);
    // A record written before authoringId existed still has the marketplace.
    expect(isAuthoredInstall(authored({ authoringId: undefined }))).toBe(true);
    expect(isAuthoredInstall(makePlugin({ marketplace: 'community' }))).toBe(false);
  });

  it('keeps authored installs out of the orphan group with no markets at all', () => {
    expect(orphanedInstalls([authored()], [])).toEqual([]);
    expect(orphanedInstalls([authored({ authoringId: undefined })], [])).toEqual([]);
  });
});
