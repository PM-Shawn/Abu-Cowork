import { describe, it, expect } from 'vitest';
import { ENTERPRISE_MARKET_NAME, isEnterpriseInstall, partitionInstalled } from './enterpriseMarket';
import type { InstalledPlugin } from './installedStore';

const rec = (marketplace: string, name = 'p'): InstalledPlugin => ({
  key: `${name}@${marketplace}`, marketplace, name, version: '1.0.0',
  installedAt: '2026-09-02T00:00:00.000Z', contributed: { skills: [], mcpServers: [] },
});

describe('enterpriseMarket', () => {
  it('reserves the name "enterprise"', () => {
    expect(ENTERPRISE_MARKET_NAME).toBe('enterprise');
  });
  it('isEnterpriseInstall keys off marketplace only', () => {
    expect(isEnterpriseInstall(rec('enterprise'))).toBe(true);
    expect(isEnterpriseInstall(rec('abu-official'))).toBe(false);
  });
  it('partitionInstalled splits personal vs organization preserving order', () => {
    const list = [rec('abu-official', 'a'), rec('enterprise', 'b'), rec('my-market', 'c')];
    const { personal, organization } = partitionInstalled(list);
    expect(personal.map(p => p.name)).toEqual(['a', 'c']);
    expect(organization.map(p => p.name)).toEqual(['b']);
  });
});
