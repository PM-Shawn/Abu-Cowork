import { describe, it, expect } from 'vitest';

import { isSelfAuthoredPlugin, orphanedInstalls } from './authored';
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
