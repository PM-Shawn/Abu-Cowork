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
  it('is false for the built-in Abu market — we authored it, the user did not', () => {
    expect(
      isSelfAuthoredPlugin(makePlugin({ marketplace: BUILTIN_MARKET_NAME, sourceKind: 'relative' })),
    ).toBe(false);
  });

  it('is false for an enterprise install — the org authored it', () => {
    expect(
      isSelfAuthoredPlugin(makePlugin({ marketplace: ENTERPRISE_MARKET_NAME, sourceKind: 'relative' })),
    ).toBe(false);
  });

  it('is true for a user market installed from a local (relative) source', () => {
    expect(isSelfAuthoredPlugin(makePlugin({ marketplace: 'my-market', sourceKind: 'relative' }))).toBe(true);
  });

  it('is false for a user market installed from a url source', () => {
    expect(
      isSelfAuthoredPlugin(makePlugin({ marketplace: 'my-market', sourceKind: 'url', sha: 'abc123' })),
    ).toBe(false);
  });

  it('is false for a user market installed from a git-subdir source', () => {
    expect(
      isSelfAuthoredPlugin(makePlugin({ marketplace: 'my-market', sourceKind: 'git-subdir', sha: 'abc123' })),
    ).toBe(false);
  });

  describe('legacy records written before sourceKind existed', () => {
    it('falls back to "has a sha" ⇒ remote ⇒ not self-authored', () => {
      expect(isSelfAuthoredPlugin(makePlugin({ marketplace: 'my-market', sha: 'abc123' }))).toBe(false);
    });

    it('falls back to "no sha" ⇒ local ⇒ self-authored', () => {
      expect(isSelfAuthoredPlugin(makePlugin({ marketplace: 'my-market' }))).toBe(true);
    });

    it('treats an explicitly undefined sha the same as an absent one', () => {
      expect(isSelfAuthoredPlugin(makePlugin({ marketplace: 'my-market', sha: undefined }))).toBe(true);
    });
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

  it('does not orphan the built-in market when it is present in the list', () => {
    const builtin = makePlugin({ key: 'b@abu-official', marketplace: BUILTIN_MARKET_NAME });
    expect(orphanedInstalls([builtin], [{ name: BUILTIN_MARKET_NAME }])).toEqual([]);
  });

  it('orphans everything personal when the marketplace list is empty', () => {
    const a = makePlugin({ key: 'a@one', marketplace: 'one' });
    const b = makePlugin({ key: 'b@two', marketplace: 'two' });
    expect(orphanedInstalls([a, b], [])).toEqual([a, b]);
  });

  it('returns [] for an empty install list', () => {
    expect(orphanedInstalls([], [{ name: 'here' }])).toEqual([]);
  });
});
