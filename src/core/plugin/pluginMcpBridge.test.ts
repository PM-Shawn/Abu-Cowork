import { describe, it, expect, vi } from 'vitest';
import { registerPluginServers, deregisterPluginServers } from './pluginMcpBridge';
import type { McpServerSpec } from './manifest';

/** A minimal fake of the mcpStore surface the bridge touches. */
function fakeMcpStore(existing: Record<string, unknown> = {}) {
  const servers: Record<string, unknown> = { ...existing };
  return {
    servers,
    has: (name: string) => name in servers,
    addServer: vi.fn((config: { name: string }) => {
      servers[config.name] = config;
    }),
    removeServer: vi.fn((name: string) => {
      delete servers[name];
    }),
  };
}

const forecast: Record<string, McpServerSpec> = {
  forecast: { command: 'npx', args: ['-y', 'weather-mcp'] },
};

describe('registerPluginServers', () => {
  it('registers a plugin server DISABLED so it never auto-connects on startup', () => {
    // The whole safety point: connectAllEnabled auto-connects enabled servers
    // at boot. A plugin server must land disabled — installing a plugin must
    // not silently start third-party code.
    const store = fakeMcpStore();
    registerPluginServers(forecast, store);

    expect(store.addServer).toHaveBeenCalledTimes(1);
    const config = store.addServer.mock.calls[0][0] as { name: string; enabled: boolean; command?: string };
    expect(config.name).toBe('forecast');
    expect(config.enabled).toBe(false);
    expect(config.command).toBe('npx');
  });

  it('maps stdio and http specs onto the mcp config shape', () => {
    const store = fakeMcpStore();
    registerPluginServers(
      {
        stdioSrv: { command: 'node', args: ['s.js'], env: { KEY: 'v' } },
        httpSrv: { url: 'https://mcp.example/sse' },
      },
      store,
    );
    const byName = Object.fromEntries(
      store.addServer.mock.calls.map((c) => [(c[0] as { name: string }).name, c[0]]),
    );
    expect(byName.stdioSrv).toMatchObject({ command: 'node', args: ['s.js'], env: { KEY: 'v' }, enabled: false });
    expect(byName.httpSrv).toMatchObject({ url: 'https://mcp.example/sse', enabled: false });
  });

  it('reports a conflict and does not overwrite a pre-existing server of the same name', () => {
    // A user's hand-configured "forecast" must not be clobbered by a plugin
    // that happens to contribute the same name.
    const store = fakeMcpStore({ forecast: { userOwned: true } });
    const result = registerPluginServers(forecast, store);

    expect(store.addServer).not.toHaveBeenCalled();
    expect(result.registered).toEqual([]);
    expect(result.conflicts).toEqual(['forecast']);
    expect((store.servers.forecast as { userOwned?: boolean }).userOwned).toBe(true);
  });

  it('returns the names it actually registered', () => {
    const store = fakeMcpStore({ taken: {} });
    const result = registerPluginServers(
      { taken: { command: 'a' }, fresh: { command: 'b' } },
      store,
    );
    expect(result.registered).toEqual(['fresh']);
    expect(result.conflicts).toEqual(['taken']);
  });

  it('does nothing for a plugin with no mcp servers', () => {
    const store = fakeMcpStore();
    const result = registerPluginServers(undefined, store);
    expect(store.addServer).not.toHaveBeenCalled();
    expect(result.registered).toEqual([]);
  });
});

describe('deregisterPluginServers', () => {
  it('removes exactly the named servers', () => {
    const store = fakeMcpStore({ forecast: {}, other: {} });
    deregisterPluginServers(['forecast'], store);
    expect(store.removeServer).toHaveBeenCalledWith('forecast');
    expect(store.has('forecast')).toBe(false);
    expect(store.has('other')).toBe(true);
  });

  it('skips a name that is no longer present', () => {
    const store = fakeMcpStore({ other: {} });
    deregisterPluginServers(['forecast'], store);
    expect(store.removeServer).not.toHaveBeenCalled();
  });

  it('handles an empty list', () => {
    const store = fakeMcpStore({ other: {} });
    deregisterPluginServers([], store);
    expect(store.removeServer).not.toHaveBeenCalled();
  });
});
