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

vi.mock('@/core/plugin/installer', () => ({ installPlugin: vi.fn(), prepareInstallRecord: vi.fn() }));
vi.mock('@/core/plugin/uninstaller', () => ({ uninstallPlugin: vi.fn() }));
vi.mock('@/core/plugin/installedStore', () => ({
  readInstalled: vi.fn(),
  readInstalledResult: vi.fn(),
  upsertInstalled: vi.fn(),
}));
// `skillRoots` is deliberately NOT mocked: the store derives the approval-gate
// names from the records it just read, through the real (pure)
// `mcpServerNamesOf`. Faking that would fake the assertions this file exists
// for — so the records in `readInstalled` are what arm the gate.
vi.mock('@/core/plugin/fsOps', () => ({ copyPluginDir: vi.fn(), removePluginDir: vi.fn() }));
// Only the disk read is faked; `expandHome` and the real update scoring stay.
vi.mock('@/core/plugin/loadMarketplace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/plugin/loadMarketplace')>()),
  loadMarketplaceFromDir: vi.fn(),
}));
vi.mock('@/core/permissions/pluginToolPolicy', () => ({ setPluginServerNames: vi.fn() }));
vi.mock('@/stores/discoveryStore', () => ({ useDiscoveryStore: { getState: () => ({ refresh: mockDiscoveryRefresh }) } }));

import { installPlugin, prepareInstallRecord } from '@/core/plugin/installer';
import { uninstallPlugin } from '@/core/plugin/uninstaller';
import { readInstalled, readInstalledResult, upsertInstalled, type InstalledPlugin } from '@/core/plugin/installedStore';
import { copyPluginDir, removePluginDir } from '@/core/plugin/fsOps';
import { loadMarketplaceFromDir } from '@/core/plugin/loadMarketplace';
import { updateAvailableKeysFor } from '@/core/plugin/updateCheck';
import type { Marketplace, MarketplaceEntry } from '@/core/plugin/marketplace';
import { setPluginServerNames } from '@/core/permissions/pluginToolPolicy';
type MarketplaceRefLike = { name: string; dir: string; builtin?: boolean };
import { useMCPStore } from './mcpStore';
import { usePluginStore, bootstrapPluginUpdates } from './pluginStore';
import { getI18n } from '@/i18n';

const mockDiscoveryRefresh = vi.fn(async () => {});
const HOME = '/Users/tester';

const weather: InstalledPlugin = {
  key: 'weather@official',
  marketplace: 'official',
  name: 'weather',
  version: '1.2.0',
  installedAt: '2026-08-31T00:00:00.000Z',
  contributed: { skills: ['forecast'], mcpServers: ['weather-mcp'], agents: ['reviewer'] },
};

function resetStore() {
  usePluginStore.setState({
    marketplaces: [],
    installed: [],
    activationByKey: {},
    activationReady: false,
    updateAvailableKeys: [],
    updateAvailableCount: 0,
    loading: false,
    error: null,
    recoveryError: null,
    unreadableOperation: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  usePluginStore.setState({ knownMcpServerNames: [] });
  vi.mocked(readInstalled).mockResolvedValue([]);
  // The store reads through the result variant; keep one knob for the tests by
  // deriving the success case from whatever `readInstalled` is mocked to. A
  // test that wants a FAILED read overrides `readInstalledResult` directly.
  vi.mocked(readInstalledResult).mockImplementation(async (home) => ({
    ok: true,
    plugins: await readInstalled(home),
  }));
});

describe('marketplaces', () => {
  it('rejects identity replacement and deduplicates an existing marketplace', () => {
    const { addMarketplace, removeMarketplace } = usePluginStore.getState();

    addMarketplace('official', '/m/official');
    addMarketplace('other', '/m/other');
    expect(usePluginStore.getState().marketplaces).toEqual([
      { name: 'official', dir: '/m/official' },
      { name: 'other', dir: '/m/other' },
    ]);

    // Re-adding the same marketplace from a new location replaces it rather
    // than creating a duplicate identity (install keys embed the name).
    expect(() => addMarketplace('official', '/m/official-v2')).toThrow();
    addMarketplace('official', '/m/official');
    expect(usePluginStore.getState().marketplaces).toEqual([
      { name: 'official', dir: '/m/official' },
      { name: 'other', dir: '/m/other' },
    ]);

    removeMarketplace('other');
    expect(usePluginStore.getState().marketplaces).toEqual([
      { name: 'official', dir: '/m/official' },
    ]);
  });

  it('addMarketplace refuses the reserved enterprise name', () => {
    expect(() => usePluginStore.getState().addMarketplace('enterprise', '/tmp/x'))
      .toThrow(/reserved marketplace name/);
    expect(usePluginStore.getState().marketplaces.some(m => m.name === 'enterprise')).toBe(false);
  });
});

describe('install', () => {
  it('re-arms the MCP approval gate with the newly installed server name', async () => {
    vi.mocked(installPlugin).mockResolvedValue({ record: weather, mcpServers: [{ name: 'weather-mcp', command: 'npx', args: ['-y', 'weather-mcp'], url: undefined }] });
    vi.mocked(readInstalled).mockResolvedValue([weather]);

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

  it('forwards the caller-supplied checksum to installPlugin', async () => {
    vi.mocked(installPlugin).mockResolvedValue({ record: weather, mcpServers: [] });
    vi.mocked(readInstalled).mockResolvedValue([weather]);

    await usePluginStore.getState().install({
      home: HOME,
      marketplaceName: 'official',
      marketplaceDir: '/m/official',
      entry: { name: 'weather', source: { kind: 'relative', path: './plugins/weather' } },
      checksum: 'a'.repeat(64),
    });

    expect(vi.mocked(installPlugin).mock.calls[0][0].checksum).toBe('a'.repeat(64));
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

    await usePluginStore.getState().uninstall(HOME, weather.key);

    expect(setPluginServerNames).toHaveBeenCalledTimes(1);
    // A stale name left behind would keep a live conversation grant that a
    // same-named plugin could later ride.
    expect([...vi.mocked(setPluginServerNames).mock.calls[0][0]]).not.toContain('weather-mcp');
    expect(usePluginStore.getState().installed).toEqual([]);
    expect(vi.mocked(uninstallPlugin).mock.calls[0][0].removeDir).toBe(removePluginDir);
  });

  it('re-scans discovery so a withdrawn plugin agent leaves the list', async () => {
    // A plugin's agents live in ~/.abu/agents, which the registry fs-watcher
    // DOES watch — but the uninstall only has to be as reliable as the install,
    // which triggers the re-scan itself. Without this the withdrawn agent stays
    // in the @-picker and the team roster for the rest of the session.
    usePluginStore.setState({ installed: [weather] });
    vi.mocked(uninstallPlugin).mockResolvedValue({
      key: weather.key,
      withdrawn: { skills: ['forecast'], mcpServers: ['weather-mcp'] },
    });
    vi.mocked(readInstalled).mockResolvedValue([]);
    mockDiscoveryRefresh.mockClear();

    await usePluginStore.getState().uninstall(HOME, weather.key);

    expect(mockDiscoveryRefresh).toHaveBeenCalledTimes(1);
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

  it('re-scans skills so a newly installed plugin skill appears without restart', async () => {
    vi.mocked(readInstalled).mockResolvedValue([]);
    mockDiscoveryRefresh.mockClear();
    await usePluginStore.getState().refreshInstalled(HOME);
    // Plugin skills live under ~/.abu/plugin-packages, which the registry
    // fs-watcher does NOT watch — so install must trigger the re-scan itself,
    // or the skill never appears in the Skills tab (or to the model) in-session.
    expect(mockDiscoveryRefresh).toHaveBeenCalledTimes(1);
  });

  it('hydrates from disk and arms the gate for plugins installed in a past session', async () => {
    vi.mocked(readInstalled).mockResolvedValue([weather]);

    await usePluginStore.getState().refreshInstalled(HOME);

    expect(usePluginStore.getState().installed).toEqual([weather]);
    expect([...vi.mocked(setPluginServerNames).mock.calls[0][0]]).toEqual(['weather-mcp']);
  });

  it('replaces the whole gate list on a successful read', async () => {
    // Whatever the previous session persisted is superseded by disk — the read
    // succeeded, so its answer is the truth, names removed included.
    usePluginStore.setState({ knownMcpServerNames: ['stale-mcp'] });
    vi.mocked(readInstalled).mockResolvedValue([weather]);

    await usePluginStore.getState().refreshInstalled(HOME);

    expect(usePluginStore.getState().knownMcpServerNames).toEqual(['weather-mcp']);
    expect(setPluginServerNames).toHaveBeenCalledWith(['weather-mcp']);
  });

  it('clears the gate when the manifest is absent — that is a real "nothing installed"', async () => {
    usePluginStore.setState({ installed: [weather], knownMcpServerNames: ['weather-mcp'] });
    // A missing file is a SUCCESSFUL read of an empty set (fresh profile, or
    // everything uninstalled), so shrinking the gate here is correct.
    vi.mocked(readInstalledResult).mockResolvedValue({ ok: true, plugins: [] });

    await usePluginStore.getState().refreshInstalled(HOME);

    expect(usePluginStore.getState().installed).toEqual([]);
    expect(usePluginStore.getState().knownMcpServerNames).toEqual([]);
    expect(setPluginServerNames).toHaveBeenCalledWith([]);
  });

  it('never widens the approval gate when the manifest cannot be read', async () => {
    // The security case. An unreadable manifest (EACCES, a half-written file,
    // an odd homeDir) used to arrive as `[]`, indistinguishable from "nothing
    // is installed" — which EMPTIES the gate: every plugin MCP tool then skips
    // the state-changing approval prompt for the session, and because the name
    // list is persisted, for the next launch too.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    usePluginStore.setState({ installed: [weather], knownMcpServerNames: ['weather-mcp'] });
    vi.mocked(readInstalledResult).mockResolvedValue({ ok: false, error: new Error('EACCES') });

    await usePluginStore.getState().refreshInstalled(HOME);

    expect(usePluginStore.getState().installed).toEqual([weather]);
    expect(usePluginStore.getState().knownMcpServerNames).toEqual(['weather-mcp']);
    expect(setPluginServerNames).not.toHaveBeenCalled();

    // And the armed list still survives into the next launch.
    const partialize = usePluginStore.persist.getOptions().partialize as
      (s: unknown) => Record<string, unknown>;
    expect(partialize(usePluginStore.getState()).knownMcpServerNames).toEqual(['weather-mcp']);
    warn.mockRestore();
  });
});

describe('bootstrapPluginUpdates', () => {
  it('connects enabled plugin MCPs after startup ownership migration', async () => {
    const { mcpManager } = await import('@/core/mcp/client');
    const { isPluginMcpAllowed } = await import('@/core/plugin/activationPolicy');
    useMCPStore.setState({ servers: { 'weather-mcp': { config: { name: 'weather-mcp', command: 'weather', enabled: true }, status: 'disconnected', tools: [] } } });
    usePluginStore.setState({ activationByKey: {}, knownMcpServerNames: ['weather-mcp'], activationReady: false });
    vi.mocked(readInstalled).mockResolvedValue([weather]);
    let finish!: () => void;
    const discovery = new Promise<void>(resolve => { finish = resolve; });
    const spy = vi.spyOn(mcpManager, 'connectServer').mockImplementation(async () => {
      expect(isPluginMcpAllowed('weather-mcp')).toBe(true);
    });
    try {
      await useMCPStore.getState().connectAllEnabled();
      expect(spy).not.toHaveBeenCalled();
      const boot = bootstrapPluginUpdates(discovery);
      finish();
      await boot;
      expect(spy).toHaveBeenCalledTimes(1);
      expect(useMCPStore.getState().servers['weather-mcp'].status).toBe('connected');
    } finally { spy.mockRestore(); useMCPStore.setState({ servers: {} }); }
  });

  it('owns one discovery scan when no prior scan is supplied', async () => {
    // The boot coordinator owns discovery after recovery.
    vi.mocked(readInstalled).mockResolvedValue([weather]);
    mockDiscoveryRefresh.mockClear();

    await bootstrapPluginUpdates();

    expect(usePluginStore.getState().installed).toEqual([weather]);
    expect(setPluginServerNames).toHaveBeenCalledWith(['weather-mcp']);
    expect(mockDiscoveryRefresh).toHaveBeenCalledTimes(1);
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
  it('preserves environment configuration through the store and real MCP registration bridge', async () => {
    const env = { REGION: 'cn east', OPTIONAL: '', TEMPLATE: '${HOME}' };
    useMCPStore.setState({ servers: {} });
    const outcome = {
      record: weather,
      mcpServers: [{ name: 'weather-mcp', command: 'node', args: ['server.js'], env }],
    };
    vi.mocked(installPlugin).mockResolvedValue(outcome);
    vi.mocked(readInstalled).mockResolvedValue([weather]);
    await usePluginStore.getState().install({
      home: HOME, marketplaceName: 'official', marketplaceDir: '/m/official',
      entry: { name: 'weather', source: { kind: 'relative', path: './plugins/weather' } },
    });
    expect(useMCPStore.getState().servers['weather-mcp'].config).toMatchObject({
      env, command: 'node', args: ['server.js'], enabled: false,
    });
    expect(useMCPStore.getState().servers['weather-mcp'].status).toBe('disconnected');
  });

  it('registers the plugin server DISABLED so nothing auto-connects', async () => {
    useMCPStore.setState({ servers: {} });
    vi.mocked(installPlugin).mockResolvedValue({ record: weather, mcpServers: [{ name: 'weather-mcp', command: 'npx', args: ['-y', 'weather-mcp'], url: undefined }] });
    vi.mocked(readInstalled).mockResolvedValue([weather]);

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

  it('forwards the caller-supplied checksum through to the nested install', async () => {
    vi.mocked(uninstallPlugin).mockResolvedValue({
      key: 'weather@official',
      withdrawn: { skills: [], mcpServers: ['weather-mcp'] },
    });
    vi.mocked(installPlugin).mockResolvedValue({ record: { ...weather, version: '2.0.0' }, mcpServers: [] });
    vi.mocked(readInstalled).mockResolvedValue([{ ...weather, version: '2.0.0' }]);

    await usePluginStore.getState().update({
      home: HOME,
      marketplaceName: 'official',
      marketplaceDir: '/m/official',
      entry: { name: 'weather', source: { kind: 'relative', path: './plugins/weather' } },
      key: 'weather@official',
      checksum: 'b'.repeat(64),
    });

    expect(vi.mocked(installPlugin).mock.calls[0][0].checksum).toBe('b'.repeat(64));
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

describe('updateAvailableKeys', () => {
  it('replaces only the given scope and keeps the other', () => {
    const s = usePluginStore.getState();
    s.setUpdateAvailableKeys(['a@abu-official', 'b@my-market'], 'personal');
    s.setUpdateAvailableKeys(['c@enterprise'], 'organization');
    expect(usePluginStore.getState().updateAvailableKeys).toEqual(['a@abu-official', 'b@my-market', 'c@enterprise']);
    s.setUpdateAvailableKeys([], 'personal');
    expect(usePluginStore.getState().updateAvailableKeys).toEqual(['c@enterprise']);
  });

  it('is pruned by refreshInstalled when the flagged install is gone (uninstall)', async () => {
    usePluginStore.setState({ updateAvailableKeys: ['weather@official', 'b@my-market'] });
    // Only `weather` survives on disk; `b@my-market` was uninstalled.
    vi.mocked(readInstalled).mockResolvedValue([weather]);
    await usePluginStore.getState().refreshInstalled(HOME);
    expect(usePluginStore.getState().updateAvailableKeys).toEqual(['weather@official']);
  });

  it('is pruned by removeMarketplace for that market only', () => {
    usePluginStore.setState({
      marketplaces: [{ name: 'official', dir: '/m' }, { name: 'my-market', dir: '/n' }],
      updateAvailableKeys: ['weather@official', 'b@my-market', 'c@enterprise'],
    });
    usePluginStore.getState().removeMarketplace('my-market');
    expect(usePluginStore.getState().updateAvailableKeys).toEqual(['weather@official', 'c@enterprise']);
  });

  it('is not persisted', () => {
    // partialize whitelist: marketplaces + knownMcpServerNames only.
    const partialize = usePluginStore.persist.getOptions().partialize as
      (s: unknown) => Record<string, unknown>;
    const persisted = partialize({
      marketplaces: [{ name: 'official', dir: '/m' }],
      knownMcpServerNames: ['forecast'],
      updateAvailableKeys: ['a@abu-official'],
    });
    expect(persisted.updateAvailableKeys).toBeUndefined();
  });
});

describe('recomputeUpdates', () => {
  /** A local-source entry, the shape whose `version` drives update detection. */
  const entry = (name: string, version: string): MarketplaceEntry => ({
    name,
    version,
    source: { kind: 'relative', path: `./${name}` },
  });
  const market = (name: string, plugins: MarketplaceEntry[]): Marketplace => ({ name, plugins });

  const installedAt = '2026-09-01T00:00:00.000Z';
  const contributed = { skills: [], mcpServers: [], agents: [] };
  const install = (name: string, marketplace: string, version: string): InstalledPlugin => ({
    key: `${name}@${marketplace}`, marketplace, name, version, installedAt, contributed,
  });

  it('unions every added market, de-duped, and agrees with updateAvailableKeysFor', async () => {
    const official = market('official', [entry('weather', '1.0.0'), entry('notes', '2.0.0')]);
    const mine = market('my-market', [entry('todo', '3.0.0')]);
    usePluginStore.setState({
      // The same pointer twice is what a hand-edited localStorage looks like;
      // the badge must count it once.
      marketplaces: [
        { name: 'official', dir: '/m/official' },
        { name: 'official', dir: '/m/official' },
        { name: 'my-market', dir: '/m/mine' },
      ] as MarketplaceRefLike[],
      installed: [
        install('weather', 'official', '0.9.0'),   // older → flagged
        install('notes', 'official', '2.0.0'),     // current → not flagged
        install('todo', 'my-market', '2.9.0'),     // older → flagged
      ],
    });
    vi.mocked(loadMarketplaceFromDir).mockImplementation(async (dir: string) =>
      dir === '/m/mine' ? mine : official,
    );

    await usePluginStore.getState().recomputeUpdates(HOME);

    const state = usePluginStore.getState();
    // Exactly what the pure detector says, market by market — the badge does
    // not get its own second opinion.
    const expectedFor = (m: Marketplace, name: string) =>
      updateAvailableKeysFor(
        m.plugins,
        new Map(state.installed.filter((p) => p.marketplace === name).map((p) => [p.name, p])),
        name,
      );
    expect(state.updateAvailableKeys).toEqual(
      [...new Set([...expectedFor(official, 'official'), ...expectedFor(mine, 'my-market')])].sort(),
    );
    expect(state.updateAvailableKeys).toEqual(['todo@my-market', 'weather@official']);
    expect(state.updateAvailableCount).toBe(2);
  });

  it('flags nothing when nothing is installed', async () => {
    usePluginStore.setState({
      marketplaces: [{ name: 'official', dir: '/m/official' }] as MarketplaceRefLike[],
      installed: [],
      updateAvailableKeys: ['weather@official'],
      updateAvailableCount: 1,
    });
    vi.mocked(loadMarketplaceFromDir).mockResolvedValue(market('official', [entry('weather', '1.0.0')]));

    await usePluginStore.getState().recomputeUpdates(HOME);

    expect(usePluginStore.getState().updateAvailableKeys).toEqual([]);
    expect(usePluginStore.getState().updateAvailableCount).toBe(0);
  });

  it('never scans the enterprise catalog, and keeps the flags its sync set', async () => {
    // The organization scope belongs to the private catalog-sync; a personal
    // scan must neither read that market nor clear what the sync reported.
    usePluginStore.setState({
      marketplaces: [
        { name: 'enterprise', dir: '/m/enterprise' },
        { name: 'official', dir: '/m/official' },
      ] as MarketplaceRefLike[],
      installed: [install('weather', 'official', '0.9.0')],
    });
    usePluginStore.getState().setUpdateAvailableKeys(['acme@enterprise'], 'organization');
    vi.mocked(loadMarketplaceFromDir).mockResolvedValue(market('official', [entry('weather', '1.0.0')]));

    await usePluginStore.getState().recomputeUpdates(HOME);

    expect(vi.mocked(loadMarketplaceFromDir).mock.calls.map((c) => c[0])).toEqual(['/m/official']);
    expect(usePluginStore.getState().updateAvailableKeys).toEqual(['acme@enterprise', 'weather@official']);
  });

  it('drops a slow scan whose newer successor already landed', async () => {
    // Two scans overlap in production (the market panel mounting while an
    // install's scan is still reading disk). The one that STARTED last holds
    // the fresher `installed`, so it must win — even though it finished first.
    // No timers: the two market reads are resolved by hand, in order.
    const deferred = () => {
      let resolve!: (m: Marketplace) => void;
      const promise = new Promise<Marketplace>((r) => { resolve = r; });
      return { promise, resolve };
    };
    const slow = deferred();
    const fast = deferred();
    const official = market('official', [entry('weather', '1.0.0')]);
    usePluginStore.setState({
      marketplaces: [{ name: 'official', dir: '/m/official' }] as MarketplaceRefLike[],
      installed: [install('weather', 'official', '0.9.0')], // stale: 1.0.0 is an update
    });
    vi.mocked(loadMarketplaceFromDir)
      .mockReturnValueOnce(slow.promise)
      .mockReturnValueOnce(fast.promise);

    // A reads the stale installed set…
    const scanA = usePluginStore.getState().recomputeUpdates(HOME);
    // …then the update lands on disk and B scans the current one.
    usePluginStore.setState({ installed: [install('weather', 'official', '1.0.0')] });
    const scanB = usePluginStore.getState().recomputeUpdates(HOME);

    fast.resolve(official);
    await scanB;
    expect(usePluginStore.getState().updateAvailableKeys).toEqual([]);

    slow.resolve(official);
    await scanA;
    // A would flag `weather@official` from the version it read before the
    // update — landing it would resurrect a badge for an up-to-date plugin.
    expect(usePluginStore.getState().updateAvailableKeys).toEqual([]);
  });

  it('lets an unreadable market contribute nothing without losing the others', async () => {
    usePluginStore.setState({
      marketplaces: [
        { name: 'broken', dir: '/m/broken' },
        { name: 'official', dir: '/m/official' },
      ] as MarketplaceRefLike[],
      installed: [install('weather', 'official', '0.9.0')],
    });
    vi.mocked(loadMarketplaceFromDir).mockImplementation(async (dir: string) => {
      if (dir === '/m/broken') throw new Error('No marketplace manifest in /m/broken');
      return market('official', [entry('weather', '1.0.0')]);
    });

    await usePluginStore.getState().recomputeUpdates(HOME);

    expect(usePluginStore.getState().updateAvailableKeys).toEqual(['weather@official']);
  });
});

describe('independent plugin master switch', () => {
  it('closes the gate before disconnecting and preserves all child preferences across off/on', async () => {
    const { useSettingsStore } = await import('./settingsStore');
    const { isPluginMcpAllowed } = await import('@/core/plugin/activationPolicy');
    const { mcpManager } = await import('@/core/mcp/client');
    useSettingsStore.setState({ disabledSkills: ['forecast'], disabledAgents: [] });
    useMCPStore.setState({ servers: {
      'weather-mcp': { config: { name: 'weather-mcp', command: 'weather', enabled: true }, status: 'connected', tools: [] },
    } });
    vi.mocked(readInstalled).mockResolvedValue([weather]);
    await usePluginStore.getState().refreshInstalled(HOME);
    const disconnect = vi.spyOn(mcpManager, 'disconnectServer').mockImplementation(async () => {
      expect(isPluginMcpAllowed('weather-mcp')).toBe(false);
    });
    const connect = vi.spyOn(mcpManager, 'connectServer').mockResolvedValue(undefined);
    try {
      await usePluginStore.getState().setPluginEnabled(weather.key, false);
      expect(useSettingsStore.getState().disabledSkills).toEqual(['forecast']);
      expect(useSettingsStore.getState().disabledAgents).toEqual([]);
      expect(useMCPStore.getState().servers['weather-mcp'].config.enabled).toBe(true);
      expect(isPluginMcpAllowed('weather-mcp')).toBe(false);
      await usePluginStore.getState().setPluginEnabled(weather.key, true);
      expect(connect).toHaveBeenCalledOnce();
      expect(useSettingsStore.getState().disabledSkills).toEqual(['forecast']);
      expect(isPluginMcpAllowed('weather-mcp')).toBe(true);
    } finally { disconnect.mockRestore(); connect.mockRestore(); }
  });

  it('does not enable a child connector that the user left disabled', async () => {
    const { mcpManager } = await import('@/core/mcp/client');
    useMCPStore.setState({ servers: {
      'weather-mcp': { config: { name: 'weather-mcp', command: 'weather', enabled: false }, status: 'disconnected', tools: [] },
    } });
    vi.mocked(readInstalled).mockResolvedValue([weather]);
    await usePluginStore.getState().refreshInstalled(HOME);
    const connect = vi.spyOn(mcpManager, 'connectServer');
    try {
      await usePluginStore.getState().setPluginEnabled(weather.key, false);
      await usePluginStore.getState().setPluginEnabled(weather.key, true);
      expect(connect).not.toHaveBeenCalled();
      expect(useMCPStore.getState().servers['weather-mcp'].config.enabled).toBe(false);
    } finally { connect.mockRestore(); }
  });

  it('does not reopen a plugin when refreshed during an update disconnect', async () => {
    const { mcpManager } = await import('@/core/mcp/client');
    const { isPluginMcpAllowed } = await import('@/core/plugin/activationPolicy');
    useMCPStore.setState({ servers: { 'weather-mcp': { config: { name: 'weather-mcp', command: 'weather', enabled: true }, status: 'connected', tools: [] } } });
    vi.mocked(readInstalled).mockResolvedValue([weather]);
    await usePluginStore.getState().refreshInstalled(HOME);
    let finish!: () => void;
    const disconnect = vi.spyOn(mcpManager, 'disconnectServer').mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    vi.mocked(uninstallPlugin).mockRejectedValueOnce(new Error('stop update'));
    try {
      const updating = usePluginStore.getState().update({ home: HOME, key: weather.key, marketplaceName: 'official', marketplaceDir: '/m', entry: { name: 'weather', source: { kind: 'relative', path: './weather' } } });
      expect(isPluginMcpAllowed('weather-mcp')).toBe(false);
      await usePluginStore.getState().refreshInstalled(HOME);
      expect(isPluginMcpAllowed('weather-mcp')).toBe(false);
      finish();
      await expect(updating).rejects.toThrow('stop update');
    } finally { disconnect.mockRestore(); }
  });

  it('persists off across rehydration and an unreadable installation manifest', async () => {
    const { isPluginMcpAllowed } = await import('@/core/plugin/activationPolicy');
    vi.mocked(readInstalled).mockResolvedValue([weather]);
    await usePluginStore.getState().refreshInstalled(HOME);
    await usePluginStore.getState().setPluginEnabled(weather.key, false);
    const saved = localStorage.getItem('abu-plugins');
    expect(JSON.parse(saved!).state.activationByKey[weather.key].enabled).toBe(false);
    usePluginStore.setState({ activationByKey: {}, activationReady: false });
    localStorage.setItem('abu-plugins', saved!);
    await usePluginStore.persist.rehydrate();
    expect(isPluginMcpAllowed('weather-mcp')).toBe(false);
    vi.mocked(readInstalledResult).mockResolvedValue({ ok: false, error: new Error('unreadable') });
    await usePluginStore.getState().refreshInstalled(HOME);
    expect(usePluginStore.getState().activationByKey[weather.key].enabled).toBe(false);
    expect(isPluginMcpAllowed('weather-mcp')).toBe(false);
  });
});


describe('managed update preparation', () => {
  it('preserves persisted intent and denies refresh while disconnecting before the journal', async () => {
    const { mcpManager } = await import('@/core/mcp/client');
    const { isPluginMcpAllowed } = await import('@/core/plugin/activationPolicy');
    const global = globalThis as typeof globalThis & { __ABU_SHELL__?: unknown };
    const originalBridge = global.__ABU_SHELL__;
    const host = vi.fn(async (action: string) => {
      if (action === 'begin') throw new Error('stop before journal');
      return null;
    });
    global.__ABU_SHELL__ = { pluginOperation: host };
    useMCPStore.setState({ servers: { 'weather-mcp': { config: { name: 'weather-mcp', command: 'weather', enabled: true }, status: 'connected', tools: [] } } });
    vi.mocked(readInstalled).mockResolvedValue([weather]);
    vi.mocked(prepareInstallRecord).mockResolvedValue(weather);
    await usePluginStore.getState().refreshInstalled(HOME);
    let finish!: () => void;
    const disconnect = vi.spyOn(mcpManager, 'disconnectServer').mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const connect = vi.spyOn(mcpManager, 'connectServer').mockResolvedValue(undefined);
    try {
      const changing = usePluginStore.getState().update({ home: HOME, key: weather.key, preparedToken: 'approved', marketplaceName: 'official', marketplaceDir: '/m', entry: { name: 'weather', source: { kind: 'relative', path: './weather' } } });
      await vi.waitFor(() => expect(disconnect).toHaveBeenCalled());
      expect(isPluginMcpAllowed('weather-mcp')).toBe(false);
      await usePluginStore.getState().refreshInstalled(HOME);
      expect(isPluginMcpAllowed('weather-mcp')).toBe(false);
      expect(usePluginStore.getState().activationByKey[weather.key].enabled).toBe(true);
      expect(JSON.parse(localStorage.getItem('abu-plugins') ?? '{}').state?.activationByKey[weather.key]?.enabled).toBe(true);
      await expect(usePluginStore.getState().setPluginEnabled(weather.key, true)).rejects.toThrow();
      finish();
      await expect(changing).rejects.toThrow('stop before journal');
      expect(usePluginStore.getState().activationByKey[weather.key].enabled).toBe(true);
    } finally { disconnect.mockRestore(); connect.mockRestore(); global.__ABU_SHELL__ = originalBridge; }
  });
});

describe('managed recovery compare-and-swap', () => {
  it('does not overwrite a standalone connector added after the transaction snapshot', async () => {
    const global = globalThis as typeof globalThis & { __ABU_SHELL__?: unknown };
    const original = global.__ABU_SHELL__;
    const independent = { name: 'shared', command: 'user-config', env: { TOKEN: 'independent-secret' }, enabled: false };
    const desired = { name: 'shared', command: 'plugin-config', enabled: false };
    const expected = { enabled: false, servers: { shared: null }, disabledSkills: {}, disabledAgents: {} };
    const host = vi.fn(async (action: string) => action === 'recover' ? {
      id: 'operation', key: weather.key, phase: 'committed', expectedRuntime: expected,
      runtime: { ...expected, enabled: true, servers: { shared: desired } },
    } : null);
    global.__ABU_SHELL__ = { pluginOperation: host };
    useMCPStore.setState({ servers: { shared: { config: independent, status: 'disconnected', tools: [] } } });
    try {
      await expect(bootstrapPluginUpdates()).rejects.toThrow(/configuration changed/);
      expect(useMCPStore.getState().servers.shared.config).toEqual(independent);
      expect(host).not.toHaveBeenCalledWith('ack', expect.anything());
      expect(usePluginStore.getState().activationReady).toBe(false);
    } finally { global.__ABU_SHELL__ = original; }
  });
});

describe('recovery awaits concurrent configuration edits', () => {
  it('rechecks after disconnect resolves and preserves the intervening user edit', async () => {
    const { mcpManager } = await import('@/core/mcp/client');
    const global = globalThis as typeof globalThis & { __ABU_SHELL__?: unknown };
    const original = global.__ABU_SHELL__;
    const old = { name: 'shared', command: 'old-config', enabled: false };
    const desired = { ...old, command: 'plugin-config' };
    const expected = { enabled: false, servers: { shared: old }, disabledSkills: {}, disabledAgents: {} };
    const host = vi.fn(async (action: string) => action === 'recover' ? {
      id: 'operation', key: weather.key, phase: 'committed', expectedRuntime: expected,
      runtime: { ...expected, servers: { shared: desired } },
    } : null);
    global.__ABU_SHELL__ = { pluginOperation: host };
    useMCPStore.setState({ servers: { shared: { config: old, status: 'connected', tools: [] } } });
    let finish!: () => void;
    const disconnect = vi.spyOn(mcpManager, 'disconnectServer').mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    try {
      const recovering = bootstrapPluginUpdates();
      await vi.waitFor(() => expect(disconnect).toHaveBeenCalled());
      useMCPStore.getState().updateServer('shared', { command: 'user-third-config' });
      finish();
      await expect(recovering).rejects.toThrow(/configuration changed/);
      expect(useMCPStore.getState().servers.shared.config.command).toBe('user-third-config');
      expect(host).not.toHaveBeenCalledWith('ack', expect.anything());
      expect(usePluginStore.getState().recoveryError).toMatch(/configuration changed/);
    } finally { disconnect.mockRestore(); global.__ABU_SHELL__ = original; }
  });
});

describe('recovery hydration must complete before journal acknowledgement', () => {
  it.each(['registry', 'discovery', 'missing activation'] as const)('keeps the journal when %s fails', async failure => {
    const global = globalThis as typeof globalThis & { __ABU_SHELL__?: unknown };
    const original = global.__ABU_SHELL__;
    const runtime = { enabled: true, servers: {}, disabledSkills: {}, disabledAgents: {} };
    const host = vi.fn(async (action: string) => action === 'recover' ? {
      id: 'operation', key: 'renamed@official', installed: true, phase: 'committed', runtime,
    } : null);
    global.__ABU_SHELL__ = { pluginOperation: host };
    if (failure === 'registry') vi.mocked(readInstalledResult).mockResolvedValue({ ok: false, error: new Error('unreadable') });
    if (failure === 'discovery') mockDiscoveryRefresh.mockRejectedValueOnce(new Error('discovery failed'));
    try {
      await expect(bootstrapPluginUpdates()).rejects.toThrow();
      expect(host).not.toHaveBeenCalledWith('ack', expect.anything());
      expect(usePluginStore.getState().activationReady).toBe(false);
    } finally { global.__ABU_SHELL__ = original; }
  });

  it('rechecks configuration after asynchronous discovery before acknowledging', async () => {
    const global = globalThis as typeof globalThis & { __ABU_SHELL__?: unknown };
    const original = global.__ABU_SHELL__;
    const config = { name: 'shared', command: 'plugin', enabled: false };
    const runtime = { enabled: false, servers: { shared: config }, disabledSkills: {}, disabledAgents: {} };
    const host = vi.fn(async (action: string) => action === 'recover' ? {
      id: 'operation', key: weather.key, phase: 'committed', expectedRuntime: runtime, runtime,
    } : null);
    global.__ABU_SHELL__ = { pluginOperation: host };
    useMCPStore.setState({ servers: {} });
    // The absent connector is an allowed previous state; the plugin adds it.
    const expected = { ...runtime, servers: { shared: null } };
    host.mockImplementation(async action => action === 'recover' ? {
      id: 'operation', key: weather.key, phase: 'committed', expectedRuntime: expected, runtime,
    } : null);
    let finish!: () => void;
    let waiting = false;
    mockDiscoveryRefresh.mockImplementationOnce(() => new Promise<void>(resolve => { waiting = true; finish = resolve; }));
    try {
      const recovering = bootstrapPluginUpdates();
      await vi.waitFor(() => expect(waiting).toBe(true));
      useMCPStore.getState().updateServer('shared', { command: 'independent-edit' });
      finish();
      await expect(recovering).rejects.toThrow(/configuration changed/);
      expect(useMCPStore.getState().servers.shared.config.command).toBe('independent-edit');
      expect(host).not.toHaveBeenCalledWith('ack', expect.anything());
    } finally { global.__ABU_SHELL__ = original; }
  });
});

it('retry recovery reaches the host reopen action before reading a closed session', async () => {
  const global = globalThis as typeof globalThis & { __ABU_SHELL__?: unknown };
  const original = global.__ABU_SHELL__;
  let closed = true;
  const host = vi.fn(async (action: string) => {
    if (action === 'recover') { closed = false; return null; }
    if (closed) throw new Error('Plugin operation: session closed');
    return null;
  });
  global.__ABU_SHELL__ = { pluginOperation: host };
  vi.mocked(readInstalledResult).mockResolvedValue({ ok: true, plugins: [] });
  try {
    await bootstrapPluginUpdates();
    expect(host.mock.calls[0][0]).toBe('recover');
    expect(usePluginStore.getState().recoveryError).toBeNull();
  } finally { global.__ABU_SHELL__ = original; }
});

/**
 * `active.enc` — the operation journal — can come back undecryptable: a
 * restored machine whose keychain entry no longer matches, a half-written file,
 * a truncated disk. The host then answers `status` with `{ unreadable: true }`
 * instead of a phase, and neither `recover` nor `commit` can make progress.
 *
 * The store must not treat that as "recovery in flight forever" (a silent,
 * permanently disabled Plugins tab). It degrades: the installed list stays
 * readable so the user can see what is at stake, the approval gate stays
 * DISARMED because no read was trusted, and the backup directories are carried
 * into state so the Plugins tab can offer to archive the journal by hand.
 */
const unreadableJournal = { unreadable: true as const, fingerprint: 'journal-identity', backupPaths: ['/backups/weather-1'] };
const shell = () => globalThis as typeof globalThis & { __ABU_SHELL__?: unknown };

describe('unreadable operation journal', () => {
  it('degrades to a readable list, leaves the approval gate disarmed and keeps the backup evidence', async () => {
    const original = shell().__ABU_SHELL__;
    const host = vi.fn(async (action: string) => (action === 'status' ? unreadableJournal : null));
    shell().__ABU_SHELL__ = { pluginOperation: host };
    vi.mocked(readInstalled).mockResolvedValue([weather]);
    usePluginStore.setState({ activationReady: true });
    try {
      await usePluginStore.getState().refreshInstalled(HOME);

      const state = usePluginStore.getState();
      expect(state.unreadableOperation).toEqual(unreadableJournal);
      expect(state.recoveryError).toBe(getI18n().toolbox.pluginsJournalUnreadable);
      expect(state.activationReady).toBe(false);
      // Visible, so the user can judge the damage...
      expect(state.installed).toEqual([weather]);
      // ...but nothing that depends on a trusted read may run.
      expect(setPluginServerNames).not.toHaveBeenCalled();
      expect(mockDiscoveryRefresh).not.toHaveBeenCalled();
    } finally { shell().__ABU_SHELL__ = original; }
  });

  it('keeps the previously known list when the registry is unreadable as well', async () => {
    const original = shell().__ABU_SHELL__;
    const host = vi.fn(async (action: string) => (action === 'status' ? unreadableJournal : null));
    shell().__ABU_SHELL__ = { pluginOperation: host };
    usePluginStore.setState({ installed: [weather] });
    vi.mocked(readInstalledResult).mockResolvedValue({ ok: false, error: new Error('installed.json unreadable') });
    try {
      await usePluginStore.getState().refreshInstalled(HOME);

      const state = usePluginStore.getState();
      // A failed read must never be mistaken for "no plugins installed".
      expect(state.installed).toEqual([weather]);
      expect(state.unreadableOperation).toEqual(unreadableJournal);
      expect(state.recoveryError).toBe(getI18n().toolbox.pluginsJournalUnreadable);
    } finally { shell().__ABU_SHELL__ = original; }
  });

  it('still fails a strict refresh so callers cannot mistake the pause for a completed scan', async () => {
    const original = shell().__ABU_SHELL__;
    const host = vi.fn(async (action: string) => (action === 'status' ? unreadableJournal : null));
    shell().__ABU_SHELL__ = { pluginOperation: host };
    vi.mocked(readInstalled).mockResolvedValue([weather]);
    try {
      await expect(usePluginStore.getState().refreshInstalled(HOME, { strict: true }))
        .rejects.toThrow(/recovery is still pending/);
      expect(usePluginStore.getState().unreadableOperation).toEqual(unreadableJournal);
      expect(usePluginStore.getState().activationReady).toBe(false);
    } finally { shell().__ABU_SHELL__ = original; }
  });
});

describe('boot with an unreadable journal', () => {
  it('reports the journal, publishes the degraded view and never acknowledges', async () => {
    const original = shell().__ABU_SHELL__;
    const host = vi.fn(async (action: string) => {
      // Recovery owns reopening the journal, so it — not `status` — fails first.
      if (action === 'recover') throw new Error('active.enc: unable to decrypt');
      return action === 'status' ? unreadableJournal : null;
    });
    shell().__ABU_SHELL__ = { pluginOperation: host };
    vi.mocked(readInstalled).mockResolvedValue([weather]);
    try {
      await expect(bootstrapPluginUpdates()).rejects.toThrow(getI18n().toolbox.pluginsJournalUnreadable);

      const state = usePluginStore.getState();
      // The raw decrypt error is replaced by the actionable one, and the
      // backup paths survive the boot reset that cleared them a moment earlier.
      expect(state.recoveryError).toBe(getI18n().toolbox.pluginsJournalUnreadable);
      expect(state.unreadableOperation).toEqual(unreadableJournal);
      expect(state.installed).toEqual([weather]);
      expect(state.activationReady).toBe(false);
      expect(host).not.toHaveBeenCalledWith('ack', expect.anything());
    } finally { shell().__ABU_SHELL__ = original; }
  });

  it('rethrows the original recovery failure when the journal itself is readable', async () => {
    const original = shell().__ABU_SHELL__;
    const host = vi.fn(async (action: string) => {
      if (action === 'recover') throw new Error('Plugin operation: session closed');
      return null;
    });
    shell().__ABU_SHELL__ = { pluginOperation: host };
    try {
      await expect(bootstrapPluginUpdates()).rejects.toThrow('session closed');

      // No journal damage was diagnosed, so the tab must not offer to archive one.
      expect(usePluginStore.getState().unreadableOperation).toBeNull();
      expect(usePluginStore.getState().recoveryError).toMatch(/session closed/);
      expect(host).not.toHaveBeenCalledWith('ack', expect.anything());
    } finally { shell().__ABU_SHELL__ = original; }
  });
});
