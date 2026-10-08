import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { usePluginStore } from '@/stores/pluginStore';
import { isFetchedMarket, isMarketAddress, marketAddFailure, refreshFetchedMarkets, removeMarket } from './marketSource';

const home = '/home/u';

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  usePluginStore.setState({
    marketplaces: [
      { name: 'abu-official', dir: '/app/builtin-plugin-market', builtin: true },
      { name: 'lawyer-market', dir: '/home/u/.abu/markets/lawyer-market' },
      { name: 'my-folder', dir: '/work/my-market' },
    ],
  });
});

describe('marketSource', () => {
  it('tells an address from a folder', () => {
    expect(isMarketAddress('https://github.com/lawyer/market')).toBe(true);
    expect(isMarketAddress('  http://files.example.com/m.zip')).toBe(true);
    expect(isMarketAddress('/work/my-market')).toBe(false);
    expect(isMarketAddress('C:\\work\\market')).toBe(false);
  });

  it('reads the failure code the main process put on the message', () => {
    expect(marketAddFailure(new Error('[auth_required] archive HTTP 403'))).toBe('auth_required');
    expect(marketAddFailure(new Error('[name_taken] a market named m already exists'))).toBe('name_taken');
    expect(marketAddFailure(new Error('something else'))).toBeUndefined();
  });

  it('knows which markets were added by address', () => {
    const [builtin, fetched, folder] = usePluginStore.getState().marketplaces;
    expect(isFetchedMarket(fetched, home)).toBe(true);
    expect(isFetchedMarket(folder, home)).toBe(false);
    expect(isFetchedMarket(builtin, home)).toBe(false);
    expect(isFetchedMarket({ name: 'w', dir: 'C:\\Users\\u\\.abu\\markets\\w' }, 'C:\\Users\\u')).toBe(true);
  });

  it('fetches only the markets added by address again, and keeps a copy that cannot be reached', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(invoke).mockRejectedValueOnce(new Error('[not_a_market] offline'));
    await refreshFetchedMarkets(home);
    expect(vi.mocked(invoke).mock.calls).toEqual([['market_source_refresh', { name: 'lawyer-market' }]]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('lawyer-market'), expect.any(Error));
    warn.mockRestore();
  });

  it('removes a market from the list, and its fetched copy only when it was fetched', async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    await removeMarket('my-folder', home);
    expect(invoke).not.toHaveBeenCalled();
    await removeMarket('lawyer-market', home);
    expect(vi.mocked(invoke).mock.calls).toEqual([['market_source_remove', { name: 'lawyer-market' }]]);
    expect(usePluginStore.getState().marketplaces.map((market) => market.name)).toEqual(['abu-official']);
  });
});
