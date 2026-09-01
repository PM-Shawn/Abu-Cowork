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
type MarketplaceRefLike = { name: string; dir: string; builtin?: boolean };
import { useMCPStore } from './mcpStore';
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
    vi.mocked(installPlugin).mockResolvedValue({ record: weather, mcpServers: [{ name: 'weather-mcp', command: 'npx', args: ['-y', 'weather-mcp'], url: undefined }] });
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

describe('built-in marketplace', () => {
  beforeEach(() => {
    usePluginStore.setState({ marketplaces: [], installed: [], knownMcpServerNames: [] });
  });

  it('injects the built-in market into the list without persisting it', () => {
    usePluginStore.getState().ensureBuiltinMarketplace('/app/builtin-plugin-market');
    const list = usePluginStore.getState().marketplaces;
    expect(list.some((m) => m.name === 'abu-official' && m.builtin === true)).toBe(true);

    // partialize must drop the built-in — its dir is a runtime-resolved
    // resource path, not something to freeze into persisted state.
    const partialize = usePluginStore.persist.getOptions().partialize as
      (s: unknown) => { marketplaces: MarketplaceRefLike[] };
    const persisted = partialize(usePluginStore.getState());
    expect(persisted.marketplaces.some((m) => m.name === 'abu-official')).toBe(false);
  });

  it('is idempotent and refreshes the resolved dir', () => {
    usePluginStore.getState().ensureBuiltinMarketplace('/old');
    usePluginStore.getState().ensureBuiltinMarketplace('/new');
    const builtins = usePluginStore.getState().marketplaces.filter((m) => m.name === 'abu-official');
    expect(builtins).toHaveLength(1);
    expect(builtins[0].dir).toBe('/new');
  });

  it('refuses to remove the built-in market', () => {
    usePluginStore.getState().ensureBuiltinMarketplace('/app/builtin-plugin-market');
    usePluginStore.getState().removeMarketplace('abu-official');
    expect(usePluginStore.getState().marketplaces.some((m) => m.name === 'abu-official')).toBe(true);
  });

  it('refuses to let a user market shadow the built-in name', () => {
    usePluginStore.getState().ensureBuiltinMarketplace('/app/builtin-plugin-market');
    usePluginStore.getState().addMarketplace('abu-official', '/tmp/evil');
    const abuOfficial = usePluginStore.getState().marketplaces.filter((m) => m.name === 'abu-official');
    expect(abuOfficial).toHaveLength(1);
    expect(abuOfficial[0].dir).toBe('/app/builtin-plugin-market'); // still the built-in
  });

  it('keeps the built-in first so it leads the market picker', () => {
    usePluginStore.getState().addMarketplace('mine', '/tmp/mine');
    usePluginStore.getState().ensureBuiltinMarketplace('/app/builtin-plugin-market');
    expect(usePluginStore.getState().marketplaces[0].name).toBe('abu-official');
  });
});

describe('plugin MCP server wiring', () => {
  it('registers the plugin server DISABLED so nothing auto-connects', async () => {
    useMCPStore.setState({ servers: {} });
    vi.mocked(installPlugin).mockResolvedValue({ record: weather, mcpServers: [{ name: 'weather-mcp', command: 'npx', args: ['-y', 'weather-mcp'], url: undefined }] });
    vi.mocked(readInstalled).mockResolvedValue([weather]);
    vi.mocked(pluginMcpServerNames).mockResolvedValue(['weather-mcp']);

    await usePluginStore.getState().install({
      home: HOME,
      marketplaceName: 'official',
      marketplaceDir: '/m/official',
      entry: { name: 'weather', source: { kind: 'relative', path: './plugins/weather' } },
    });

    const entry = useMCPStore.getState().servers['weather-mcp'];
    expect(entry).toBeTruthy();
    // The safety invariant: installing a plugin must NOT arm auto-connect.
    expect(entry.config.enabled).toBe(false);
    expect(entry.config.command).toBe('npx');
  });

  it('removes the plugin server on uninstall', async () => {
    useMCPStore.setState({
      servers: {
        'weather-mcp': { config: { name: 'weather-mcp', enabled: false }, status: 'disconnected', tools: [] },
        'user-own': { config: { name: 'user-own', enabled: true }, status: 'disconnected', tools: [] },
      },
    });
    vi.mocked(uninstallPlugin).mockResolvedValue({
      key: 'weather@official',
      withdrawn: { skills: ['forecast'], mcpServers: ['weather-mcp'] },
    });
    vi.mocked(readInstalled).mockResolvedValue([]);
    vi.mocked(pluginMcpServerNames).mockResolvedValue([]);

    await usePluginStore.getState().uninstall(HOME, 'weather@official');

    expect(useMCPStore.getState().servers['weather-mcp']).toBeUndefined();
    // A user's own server of a different name is untouched.
    expect(useMCPStore.getState().servers['user-own']).toBeTruthy();
  });

  it('does not clobber a user server that shares the plugin server name', async () => {
    useMCPStore.setState({
      servers: {
        'weather-mcp': { config: { name: 'weather-mcp', enabled: true, command: 'user-cmd' }, status: 'connected', tools: [] },
      },
    });
    vi.mocked(installPlugin).mockResolvedValue({ record: weather, mcpServers: [{ name: 'weather-mcp', command: 'npx', args: ['-y', 'weather-mcp'], url: undefined }] });
    vi.mocked(readInstalled).mockResolvedValue([weather]);
    vi.mocked(pluginMcpServerNames).mockResolvedValue(['weather-mcp']);

    await usePluginStore.getState().install({
      home: HOME,
      marketplaceName: 'official',
      marketplaceDir: '/m/official',
      entry: { name: 'weather', source: { kind: 'relative', path: './plugins/weather' } },
    });

    // The user's server is left exactly as it was — not overwritten, not disabled.
    const entry = useMCPStore.getState().servers['weather-mcp'];
    expect(entry.config.command).toBe('user-cmd');
    expect(entry.config.enabled).toBe(true);
  });
});

describe('update', () => {
  it('replaces an installed plugin by uninstalling the old version then installing the new', async () => {
    const installOrder: string[] = [];
    vi.mocked(uninstallPlugin).mockImplementation(async () => {
      installOrder.push('uninstall');
      return { key: 'weather@official', withdrawn: { skills: [], mcpServers: ['weather-mcp'] } };
    });
    vi.mocked(installPlugin).mockImplementation(async () => {
      installOrder.push('install');
      return { record: { ...weather, version: '2.0.0' }, mcpServers: [] };
    });
    vi.mocked(readInstalled).mockResolvedValue([{ ...weather, version: '2.0.0' }]);
    vi.mocked(pluginMcpServerNames).mockResolvedValue([]);

    await usePluginStore.getState().update({
      home: HOME,
      marketplaceName: 'official',
      marketplaceDir: '/m/official',
      entry: { name: 'weather', source: { kind: 'relative', path: './plugins/weather' } },
      key: 'weather@official',
    });

    // Old version must be torn down before the new one lands, so no orphan
    // version dir and no stale MCP registration survive.
    expect(installOrder).toEqual(['uninstall', 'install']);
    expect(usePluginStore.getState().installed[0].version).toBe('2.0.0');
  });

  it('does not install a new version if uninstalling the old one fails', async () => {
    vi.mocked(uninstallPlugin).mockRejectedValue(new Error('EPERM'));
    await expect(
      usePluginStore.getState().update({
        home: HOME, marketplaceName: 'official', marketplaceDir: '/m/official',
        entry: { name: 'weather', source: { kind: 'relative', path: './plugins/weather' } },
        key: 'weather@official',
      }),
    ).rejects.toThrow('EPERM');
    expect(installPlugin).not.toHaveBeenCalled();
  });
});

describe('MCP server conflict safety (security review blocker #1)', () => {
  it('uninstall does NOT delete a user server the plugin only collided with', async () => {
    // User owns "weather-mcp"; the plugin declares the same name. Registration
    // must not clobber it (already covered) AND uninstall must not delete it —
    // the record must credit the plugin with only what it actually created.
    useMCPStore.setState({
      servers: {
        'weather-mcp': { config: { name: 'weather-mcp', enabled: true, command: 'user-cmd' }, status: 'connected', tools: [] },
      },
    });
    vi.mocked(installPlugin).mockResolvedValue({
      record: weather, // weather.contributed.mcpServers = ['weather-mcp']
      mcpServers: [{ name: 'weather-mcp', command: 'npx', args: ['-y', 'weather-mcp'], url: undefined }],
    });
    // Capture what install actually persists (the corrected record).
    let persisted: InstalledPlugin | undefined;
    vi.mocked(upsertInstalled).mockImplementation(async (_home, rec) => { persisted = rec; });
    vi.mocked(readInstalled).mockResolvedValue([weather]);
    vi.mocked(pluginMcpServerNames).mockResolvedValue([]);

    await usePluginStore.getState().install({
      home: HOME, marketplaceName: 'official', marketplaceDir: '/m/official',
      entry: { name: 'weather', source: { kind: 'relative', path: './plugins/weather' } },
    });

    // The persisted record must NOT credit the plugin with the user's server.
    expect(persisted?.contributed.mcpServers).toEqual([]);
    // And the user's server is still there after install.
    expect(useMCPStore.getState().servers['weather-mcp'].config.command).toBe('user-cmd');
  });
})
