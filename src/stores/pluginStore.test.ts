// @vitest-environment happy-dom
/**
 * The load-bearing assertions here are the two `setPluginServerNames` ones.
 *
 * `pluginToolPolicy` holds the plugin-contributed MCP server names in a
 * module-level set that nothing re-reads from disk. If install forgets to
 * refresh it, a newly installed plugin's tools skip the approval prompt
 * entirely; if uninstall forgets, a stale name (and its conversation grant)
 * outlives the plugin. Neither failure is visible in the UI, so it has to be
 * pinned here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/core/plugin/installer', () => ({ installPlugin: vi.fn() }));
vi.mock('@/core/plugin/uninstaller', () => ({ uninstallPlugin: vi.fn() }));
vi.mock('@/core/plugin/installedStore', () => ({
  readInstalled: vi.fn(),
  upsertInstalled: vi.fn(),
}));
vi.mock('@/core/plugin/fsOps', () => ({ copyPluginDir: vi.fn(), removePluginDir: vi.fn() }));
vi.mock('@/core/plugin/skillRoots', () => ({ pluginMcpServerNames: vi.fn() }));
vi.mock('@/core/permissions/pluginToolPolicy', () => ({ setPluginServerNames: vi.fn() }));

import { installPlugin } from '@/core/plugin/installer';
import { uninstallPlugin } from '@/core/plugin/uninstaller';
import { readInstalled, upsertInstalled, type InstalledPlugin } from '@/core/plugin/installedStore';
import { copyPluginDir, removePluginDir } from '@/core/plugin/fsOps';
import { pluginMcpServerNames } from '@/core/plugin/skillRoots';
import { setPluginServerNames } from '@/core/permissions/pluginToolPolicy';
import { usePluginStore } from './pluginStore';

const HOME = '/Users/tester';

const weather: InstalledPlugin = {
  key: 'weather@official',
  marketplace: 'official',
  name: 'weather',
  version: '1.2.0',
  installedAt: '2026-08-31T00:00:00.000Z',
  contributed: { skills: ['forecast'], mcpServers: ['weather-mcp'] },
};

function resetStore() {
  usePluginStore.setState({ marketplaces: [], installed: [], loading: false, error: null });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  vi.mocked(readInstalled).mockResolvedValue([]);
  vi.mocked(pluginMcpServerNames).mockResolvedValue([]);
});

describe('marketplaces', () => {
  it('adds, replaces by name, and removes marketplace pointers', () => {
    const { addMarketplace, removeMarketplace } = usePluginStore.getState();

    addMarketplace('official', '/m/official');
    addMarketplace('other', '/m/other');
    expect(usePluginStore.getState().marketplaces).toEqual([
      { name: 'official', dir: '/m/official' },
      { name: 'other', dir: '/m/other' },
    ]);

    // Re-adding the same marketplace from a new location replaces it rather
    // than creating a duplicate identity (install keys embed the name).
    addMarketplace('official', '/m/official-v2');
    expect(usePluginStore.getState().marketplaces).toEqual([
      { name: 'other', dir: '/m/other' },
      { name: 'official', dir: '/m/official-v2' },
    ]);

    removeMarketplace('other');
    expect(usePluginStore.getState().marketplaces).toEqual([
      { name: 'official', dir: '/m/official-v2' },
    ]);
  });
});

describe('install', () => {
  it('re-arms the MCP approval gate with the newly installed server name', async () => {
    vi.mocked(installPlugin).mockResolvedValue(weather);
    vi.mocked(readInstalled).mockResolvedValue([weather]);
    vi.mocked(pluginMcpServerNames).mockResolvedValue(['weather-mcp']);

    await usePluginStore.getState().install({
      home: HOME,
      marketplaceName: 'official',
      marketplaceDir: '/m/official',
      entry: { name: 'weather', source: { kind: 'relative', path: './plugins/weather' } },
    });

    // Without this the plugin's MCP tools would run with no approval prompt.
    expect(setPluginServerNames).toHaveBeenCalledTimes(1);
    expect([...vi.mocked(setPluginServerNames).mock.calls[0][0]]).toContain('weather-mcp');

    // Record persisted, real copy primitive injected, list mirrored.
    expect(upsertInstalled).toHaveBeenCalledWith(HOME, weather);
    await vi.mocked(installPlugin).mock.calls[0][0].copyDir('/from', '/to');
    expect(copyPluginDir).toHaveBeenCalledWith('/from', '/to');
    expect(usePluginStore.getState().installed).toEqual([weather]);
    expect(usePluginStore.getState().loading).toBe(false);
  });

  it('surfaces the failure and writes no install record when the copy fails', async () => {
    vi.mocked(installPlugin).mockRejectedValue(new Error('disk full'));

    await expect(
      usePluginStore.getState().install({
        home: HOME,
        marketplaceName: 'official',
        marketplaceDir: '/m/official',
        entry: { name: 'weather', source: { kind: 'relative', path: './plugins/weather' } },
      }),
    ).rejects.toThrow('disk full');

    expect(upsertInstalled).not.toHaveBeenCalled();
    expect(setPluginServerNames).not.toHaveBeenCalled();
    expect(usePluginStore.getState().error).toBe('disk full');
    expect(usePluginStore.getState().loading).toBe(false);
  });
});

describe('uninstall', () => {
  it('re-arms the MCP approval gate without the removed server name', async () => {
    usePluginStore.setState({ installed: [weather] });
    vi.mocked(uninstallPlugin).mockResolvedValue({
      key: weather.key,
      withdrawn: { skills: ['forecast'], mcpServers: ['weather-mcp'] },
    });
    vi.mocked(readInstalled).mockResolvedValue([]);
    vi.mocked(pluginMcpServerNames).mockResolvedValue([]);

    await usePluginStore.getState().uninstall(HOME, weather.key);

    expect(setPluginServerNames).toHaveBeenCalledTimes(1);
    // A stale name left behind would keep a live conversation grant that a
    // same-named plugin could later ride.
    expect([...vi.mocked(setPluginServerNames).mock.calls[0][0]]).not.toContain('weather-mcp');
    expect(usePluginStore.getState().installed).toEqual([]);
    expect(vi.mocked(uninstallPlugin).mock.calls[0][0].removeDir).toBe(removePluginDir);
  });

  it('keeps the plugin listed and records the error when removal fails', async () => {
    usePluginStore.setState({ installed: [weather] });
    vi.mocked(uninstallPlugin).mockRejectedValue(new Error('EPERM'));

    await expect(usePluginStore.getState().uninstall(HOME, weather.key)).rejects.toThrow('EPERM');

    expect(setPluginServerNames).not.toHaveBeenCalled();
    expect(usePluginStore.getState().installed).toEqual([weather]);
    expect(usePluginStore.getState().error).toBe('EPERM');
  });
});

describe('refreshInstalled', () => {
  it('hydrates from disk and arms the gate for plugins installed in a past session', async () => {
    vi.mocked(readInstalled).mockResolvedValue([weather]);
    vi.mocked(pluginMcpServerNames).mockResolvedValue(['weather-mcp']);

    await usePluginStore.getState().refreshInstalled(HOME);

    expect(usePluginStore.getState().installed).toEqual([weather]);
    expect([...vi.mocked(setPluginServerNames).mock.calls[0][0]]).toEqual(['weather-mcp']);
  });
});

describe('boot-time approval gate', () => {
  // The gate lives in a module-level Set that starts empty, and installed.json
  // is only readable asynchronously. Without persisted names, every plugin
  // tool called before the Plugins tab is first opened would classify as
  // `null` → 'allow' — the exact silent-execution gap this module exists to
  // close. These tests pin the persisted-names contract.

  it('persists the contributed server names alongside the marketplaces', () => {
    const partialize = (usePluginStore.persist.getOptions().partialize) as
      (s: unknown) => Record<string, unknown>;
    const persisted = partialize({
      marketplaces: [{ name: 'official', dir: '/m' }],
      installed: [{ key: 'weather@official' }],
      knownMcpServerNames: ['forecast'],
      error: 'transient',
    });

    expect(persisted.knownMcpServerNames).toEqual(['forecast']);
    expect(persisted.marketplaces).toEqual([{ name: 'official', dir: '/m' }]);
    // installed.json stays the single source of truth for what is installed.
    expect(persisted.installed).toBeUndefined();
    expect(persisted.error).toBeUndefined();
  });

  it('migrates a v1 payload to an empty server-name list rather than dropping the key', () => {
    const migrate = usePluginStore.persist.getOptions().migrate as
      (p: unknown, v: number) => Record<string, unknown>;
    const migrated = migrate({ marketplaces: [{ name: 'official', dir: '/m' }] }, 1);

    expect(migrated.knownMcpServerNames).toEqual([]);
    expect(migrated.marketplaces).toEqual([{ name: 'official', dir: '/m' }]);
  });

  it('distrusts a pre-v1 payload entirely', () => {
    const migrate = usePluginStore.persist.getOptions().migrate as
      (p: unknown, v: number) => Record<string, unknown>;
    expect(migrate({ marketplaces: 'junk' }, 0)).toEqual({
      marketplaces: [],
      knownMcpServerNames: [],
    });
  });
});
