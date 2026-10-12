import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { readTextFile } from '@tauri-apps/plugin-fs';
import type { Marketplace } from '@/core/plugin/marketplace';
import { loadMarketplaceFromDir } from '@/core/plugin/loadMarketplace';
import type { MarketplaceRef } from '@/stores/pluginStore';
import { loadAppListings } from './appMarket';
import type { RefCatalog } from './appRefs';

// Reading a market's own list is the subject of `loadMarketplace`'s tests; here it either
// answers with what the market lists or fails the way the reader does.
vi.mock('@/core/plugin/loadMarketplace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/plugin/loadMarketplace')>()),
  loadMarketplaceFromDir: vi.fn(),
}));

const acme: MarketplaceRef = { name: 'acme', dir: '/Users/testuser/.abu/markets/acme' };
const gone: MarketplaceRef = { name: 'gone', dir: '/Users/testuser/.abu/markets/gone' };
const catalog: RefCatalog = {
  plugins: [], teams: [], getAgent: () => undefined, findManagedAgent: () => undefined,
  skillNames: new Set(), enterpriseSkillNames: new Set(),
};
const listed: Marketplace = {
  name: 'acme',
  plugins: [],
  apps: [{ name: 'broken', source: { kind: 'relative', path: './apps/broken' }, version: '1.0.0' }],
};

describe('loadAppListings', () => {
  let warn: MockInstance<typeof console.warn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(loadMarketplaceFromDir).mockReset();
  });
  afterEach(() => { warn.mockRestore(); });

  it('marks an app whose own file does not read, and sends what the parser said to the console only', async () => {
    vi.mocked(loadMarketplaceFromDir).mockResolvedValue(listed);
    vi.mocked(readTextFile).mockResolvedValueOnce('{ "name": "broken" }');

    const result = await loadAppListings([acme], catalog);

    expect(result.failures).toEqual([]);
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0]).toMatchObject({ appId: 'broken@acme', name: 'broken', invalid: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe('[app] read app "broken" of market "acme" failed:');
  });

  it('names a market whose list cannot be read, keeps the others, and sends the reason to the console only', async () => {
    vi.mocked(loadMarketplaceFromDir).mockImplementation(async (dir) => {
      if (dir === gone.dir) throw new Error(`Marketplace manifest is not valid JSON: ${gone.dir}/.abu-plugin/marketplace.json`);
      return { name: 'acme', plugins: [], apps: [] };
    });

    const result = await loadAppListings([gone, acme], catalog);

    expect(result).toEqual({ listings: [], failures: [{ market: gone }] });
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[app] read market "gone" failed:',
      `Marketplace manifest is not valid JSON: ${gone.dir}/.abu-plugin/marketplace.json`,
    );
  });
});
