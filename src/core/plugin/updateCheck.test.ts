import { describe, it, expect } from 'vitest';
import { entryUpdateStatus, updateAvailableKeysFor, type UpdateStatus } from './updateCheck';
import type { InstalledPlugin } from './installedStore';
import type { MarketplaceEntry } from './marketplace';

const installed = (over: Partial<InstalledPlugin> = {}): InstalledPlugin => ({
  key: 'weather@official', marketplace: 'official', name: 'weather', version: '1.0.0',
  installedAt: '2026-09-01T00:00:00.000Z', contributed: { skills: [], mcpServers: [] }, ...over,
});

const relEntry = (version?: string): MarketplaceEntry => ({
  name: 'weather', version, source: { kind: 'relative', path: './plugins/weather' },
});
const remoteEntry = (sha: string): MarketplaceEntry => ({
  name: 'weather', source: { kind: 'url', url: 'https://x/y.git', sha },
});

describe('entryUpdateStatus', () => {
  it('reports not-installed when nothing matches', () => {
    expect(entryUpdateStatus(relEntry('1.0.0'), undefined)).toBe<UpdateStatus>('not-installed');
  });

  describe('local (relative) source — compares version', () => {
    it('up-to-date when versions match', () => {
      expect(entryUpdateStatus(relEntry('1.0.0'), installed({ version: '1.0.0' }))).toBe('up-to-date');
    });
    it('update-available when the marketplace version differs', () => {
      expect(entryUpdateStatus(relEntry('1.1.0'), installed({ version: '1.0.0' }))).toBe('update-available');
    });
    it('up-to-date when the entry omits a version (nothing to compare)', () => {
      expect(entryUpdateStatus(relEntry(undefined), installed({ version: '1.0.0' }))).toBe('up-to-date');
    });
  });

  describe('remote source — compares sha', () => {
    it('up-to-date when the pinned sha matches what is installed', () => {
      expect(entryUpdateStatus(remoteEntry('abc'), installed({ sha: 'abc' }))).toBe('up-to-date');
    });
    it('update-available when the marketplace pins a different sha', () => {
      expect(entryUpdateStatus(remoteEntry('def'), installed({ sha: 'abc' }))).toBe('update-available');
    });
    it('update-available when installed has no recorded sha (legacy install)', () => {
      expect(entryUpdateStatus(remoteEntry('def'), installed({ sha: undefined }))).toBe('update-available');
    });
  });
});

describe('updateAvailableKeysFor', () => {
  it('includes a relative-source entry whose declared version is newer than installed', () => {
    const byName = new Map([['weather', installed({ name: 'weather', version: '1.0.0' })]]);
    const keys = updateAvailableKeysFor([relEntry('1.1.0')], byName, 'official');
    expect(keys).toEqual(['weather@official']);
  });

  it('excludes an up-to-date entry and a not-installed entry', () => {
    const byName = new Map([['weather', installed({ name: 'weather', version: '1.0.0' })]]);
    const keys = updateAvailableKeysFor(
      [relEntry('1.0.0'), { name: 'not-installed-plugin', version: '1.0.0', source: { kind: 'relative', path: './x' } }],
      byName,
      'official',
    );
    expect(keys).toEqual([]);
  });

  it('includes a remote entry whose pinned sha differs from what is installed', () => {
    const byName = new Map([['weather', installed({ name: 'weather', sha: 'abc' })]]);
    const keys = updateAvailableKeysFor([remoteEntry('def')], byName, 'official');
    expect(keys).toEqual(['weather@official']);
  });

  it('sorts the result and keys by the passed marketplace name, not the entry name', () => {
    const byName = new Map([
      ['zeta', installed({ name: 'zeta', version: '1.0.0' })],
      ['alpha', installed({ name: 'alpha', version: '1.0.0' })],
    ]);
    const entries: MarketplaceEntry[] = [
      { name: 'zeta', version: '2.0.0', source: { kind: 'relative', path: './zeta' } },
      { name: 'alpha', version: '2.0.0', source: { kind: 'relative', path: './alpha' } },
    ];
    // "my-market" is the marketplace *pointer* name, distinct from any name
    // the entries or their manifest declare internally.
    const keys = updateAvailableKeysFor(entries, byName, 'my-market');
    expect(keys).toEqual(['alpha@my-market', 'zeta@my-market']);
  });
});
