import { describe, it, expect, vi } from 'vitest';
import { resolveBuiltinMarketDir, BUILTIN_MARKET_NAME } from './builtinMarket';

describe('resolveBuiltinMarketDir', () => {
  it('uses the packaged resource dir when it exists', async () => {
    const dir = await resolveBuiltinMarketDir({
      resolveResource: async (n) => `/app/Resources/${n}`,
      resolve: async () => '/should/not/be/used',
      exists: async (p) => p === '/app/Resources/builtin-plugin-market',
    });
    expect(dir).toBe('/app/Resources/builtin-plugin-market');
  });

  it('falls back to the dev checkout when resolveResource has nothing', async () => {
    const dir = await resolveBuiltinMarketDir({
      resolveResource: async () => {
        throw new Error('no resource root in dev');
      },
      resolve: async (p) => `/repo/${p.replace('../', '')}`,
      exists: async (p) => p === '/repo/builtin-plugin-market',
    });
    expect(dir).toBe('/repo/builtin-plugin-market');
  });

  it('returns null rather than throwing when the bundle is missing entirely', async () => {
    // A missing built-in market must degrade to "no built-in market", never
    // take the plugins page down.
    const dir = await resolveBuiltinMarketDir({
      resolveResource: async () => {
        throw new Error('none');
      },
      resolve: async (p) => `/nowhere/${p}`,
      exists: async () => false,
    });
    expect(dir).toBeNull();
  });

  it('prefers the packaged path over the dev fallback', async () => {
    const resolveFn = vi.fn(async (p: string) => `/repo/${p}`);
    const dir = await resolveBuiltinMarketDir({
      resolveResource: async (n) => `/app/${n}`,
      resolve: resolveFn,
      exists: async () => true, // both would exist; packaged must win
    });
    expect(dir).toBe('/app/builtin-plugin-market');
    expect(resolveFn).not.toHaveBeenCalled();
  });

  it('exposes a stable market name', () => {
    expect(BUILTIN_MARKET_NAME).toBe('abu-official');
  });
});
