import { describe, it, expect } from 'vitest';
import { entryUpdateStatus, type UpdateStatus } from './updateCheck';
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
