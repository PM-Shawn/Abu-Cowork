import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_REGISTRY,
  ELECTRON_CHROME_BRIDGE_COMMAND,
  ensureMCPServer,
  getArgLabel,
  getRegistryEntry,
  getSetupHint,
  installMCPServer,
  provisionFirstPartyMCPServers,
  resolveMCPCompanionResource,
} from './mcpDiscovery';
import { useMCPStore } from '../../stores/mcpStore';
import { getI18n, type TranslationDict } from '../../i18n';
import zhCN from '../../i18n/locales/zh-CN';
import enUS from '../../i18n/locales/en-US';

const resolveResource = vi.hoisted(() => vi.fn());
const resolve = vi.hoisted(() => vi.fn());
const exists = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/path', () => ({
  resolveResource: (...args: unknown[]) => resolveResource(...args),
  resolve: (...args: unknown[]) => resolve(...args),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: (...args: unknown[]) => exists(...args),
}));

describe('Chrome bridge MCP registry', () => {
  beforeEach(() => {
    resolveResource.mockReset();
    resolve.mockReset();
    exists.mockReset();
    const runtime = globalThis as typeof globalThis & {
      __ABU_SHELL__?: { mainSupervisesSidecar?: boolean };
    };
    runtime.__ABU_SHELL__ = undefined;
    useMCPStore.setState({ servers: {}, isLoading: false });
  });

  it('always represents the optional external Chrome extension bridge', () => {
    expect(getRegistryEntry('abu-browser-bridge')).toMatchObject({
      command: 'npx',
      args: ['-y', 'abu-browser-bridge@latest'],
      env: {},
      bundledResourceDir: 'browser-extension',
    });
  });

  it('uses and provisions the bundled first-party bridge in Electron', () => {
    const runtime = globalThis as typeof globalThis & {
      __ABU_SHELL__?: { mainSupervisesSidecar?: boolean };
    };
    runtime.__ABU_SHELL__ = { mainSupervisesSidecar: true };

    expect(getRegistryEntry('abu-browser-bridge')).toMatchObject({
      command: ELECTRON_CHROME_BRIDGE_COMMAND,
      args: [],
    });

    provisionFirstPartyMCPServers();
    expect(useMCPStore.getState().servers['abu-browser-bridge']).toMatchObject({
      config: {
        command: ELECTRON_CHROME_BRIDGE_COMMAND,
        args: [],
        enabled: true,
      },
      status: 'disconnected',
    });
  });

  it('migrates an old Electron npx config without undoing explicit disable', () => {
    const runtime = globalThis as typeof globalThis & {
      __ABU_SHELL__?: { mainSupervisesSidecar?: boolean };
    };
    runtime.__ABU_SHELL__ = { mainSupervisesSidecar: true };
    useMCPStore.getState().addServer({
      name: 'abu-browser-bridge',
      command: 'npx',
      args: ['-y', 'abu-browser-bridge@latest'],
      env: {},
      enabled: false,
    });

    provisionFirstPartyMCPServers();

    expect(useMCPStore.getState().servers['abu-browser-bridge'].config).toMatchObject({
      command: ELECTRON_CHROME_BRIDGE_COMMAND,
      args: [],
      enabled: false,
    });
  });

  it('does not reconnect a first-party bridge the user explicitly disabled', async () => {
    const runtime = globalThis as typeof globalThis & {
      __ABU_SHELL__?: { mainSupervisesSidecar?: boolean };
    };
    runtime.__ABU_SHELL__ = { mainSupervisesSidecar: true };
    useMCPStore.getState().addServer({
      name: 'abu-browser-bridge',
      command: ELECTRON_CHROME_BRIDGE_COMMAND,
      args: [],
      env: {},
      enabled: false,
    });
    const connectServer = vi.spyOn(useMCPStore.getState(), 'connectServer');

    await expect(ensureMCPServer('abu-browser-bridge')).resolves.toMatchObject({
      status: 'needs_config',
      message: expect.stringContaining('turned off by the user'),
    });
    expect(connectServer).not.toHaveBeenCalled();
    expect(useMCPStore.getState().servers['abu-browser-bridge']).toMatchObject({
      config: { enabled: false },
      status: 'disconnected',
    });
  });

  it('finds the real Chrome extension build output in Electron development', async () => {
    resolveResource.mockResolvedValue('/repo/browser-extension');
    resolve.mockImplementation((candidate: string) => Promise.resolve(`/repo/${candidate}`));
    exists.mockImplementation((candidate: string) => Promise.resolve(
      candidate === '/repo/abu-chrome-extension/dist',
    ));

    await expect(resolveMCPCompanionResource('abu-browser-bridge'))
      .resolves.toBe('/repo/abu-chrome-extension/dist');
    expect(resolve).toHaveBeenCalledWith('abu-chrome-extension/dist');
  });
});

/**
 * Data invariants for the single connector catalog.
 *
 * `BUILTIN_REGISTRY` is the one source of truth for connectors (the marketplace
 * template array is a derived view of it). Everything a user can install from
 * 「市场」 or the agent can install from `manage_mcp_server` comes from here, so
 * a stale package name or a missing translation is not a cosmetic defect — it
 * is an install that 404s or a blank row. These tests pin the shape.
 */
describe('BUILTIN_REGISTRY data invariants', () => {
  /**
   * Packages the 2026-09-05 `npm view` audit found unpublished, archived, or
   * superseded. None of them may come back into the catalog: each one is a
   * connector that either cannot install at all or installs something dead.
   */
  const RETIRED_PACKAGES = [
    '@modelcontextprotocol/server-filesystem',
    '@modelcontextprotocol/server-sqlite',
    '@modelcontextprotocol/server-fetch',
    '@modelcontextprotocol/server-google-maps',
    '@modelcontextprotocol/server-puppeteer',
    '@modelcontextprotocol/server-brave-search',
    '@notionhq/mcp-server-notion',
    '@sentry/mcp-server-sentry',
  ];

  it('gives every entry a unique name', () => {
    const names = BUILTIN_REGISTRY.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('installs every entry through npx -y', () => {
    for (const entry of BUILTIN_REGISTRY) {
      expect(entry.command).toBe('npx');
      expect(entry.args[0]).toBe('-y');
    }
  });

  it('names no unpublished or retired npm package', () => {
    for (const entry of BUILTIN_REGISTRY) {
      for (const arg of entry.args) {
        expect(arg.startsWith('@anthropic/')).toBe(false);
        expect(RETIRED_PACKAGES).not.toContain(arg.replace(/@[^@/]*$/, ''));
        expect(RETIRED_PACKAGES).not.toContain(arg);
      }
    }
  });

  it('gives every env placeholder a matching required env var', () => {
    for (const entry of BUILTIN_REGISTRY) {
      for (const key of Object.keys(entry.envPlaceholders ?? {})) {
        expect(Object.keys(entry.env)).toContain(key);
      }
    }
  });

  it('points every configurable argument at a real slot', () => {
    for (const entry of BUILTIN_REGISTRY) {
      for (const slot of entry.configurableArgs ?? []) {
        expect(slot.index).toBeGreaterThan(0);
        expect(slot.index).toBeLessThan(entry.args.length);
        expect(slot.placeholder).not.toBe('');
      }
    }
  });

  it('keeps the retired connectors out of the catalog', () => {
    const names = new Set(BUILTIN_REGISTRY.map((entry) => entry.name));
    for (const gone of ['filesystem', 'sqlite', 'fetch', 'google-maps', 'puppeteer']) {
      expect(names.has(gone)).toBe(false);
    }
  });

  it('carries the connectors migrated in from the marketplace templates', () => {
    const byName = new Map(BUILTIN_REGISTRY.map((entry) => [entry.name, entry]));
    expect(byName.get('playwright')?.args).toEqual(['-y', '@playwright/mcp@latest']);
    expect(byName.get('chrome-devtools')?.args).toEqual(['-y', 'chrome-devtools-mcp@latest']);
    expect(byName.get('sentry')).toMatchObject({
      args: ['-y', '@sentry/mcp-server'],
      env: { SENTRY_ACCESS_TOKEN: '' },
    });
  });

  it('takes the postgres connection string as a positional argument, not an env var', () => {
    const postgres = BUILTIN_REGISTRY.find((entry) => entry.name === 'postgres');
    expect(postgres?.env).toEqual({});
    expect(postgres?.configurableArgs).toEqual([
      { index: 2, placeholder: 'postgresql://user:pass@localhost:5432/db' },
    ]);
  });

  it('gives the browser bridge the longer timeout browser automation needs', () => {
    const bridge = BUILTIN_REGISTRY.find((entry) => entry.name === 'abu-browser-bridge');
    expect(bridge?.defaultTimeout).toBe(120000);
  });
});

describe('BUILTIN_REGISTRY i18n completeness', () => {
  const dicts: [string, TranslationDict][] = [['zh-CN', zhCN], ['en-US', enUS]];

  it.each(dicts)('describes every connector in %s', (_locale, dict) => {
    for (const entry of BUILTIN_REGISTRY) {
      expect(dict.toolResult.system.mcpCatalog[entry.name]).toBeTruthy();
    }
  });

  it.each(dicts)('keeps no description for a connector that left the catalog (%s)', (_locale, dict) => {
    const names = new Set(BUILTIN_REGISTRY.map((entry) => entry.name));
    for (const key of Object.keys(dict.toolResult.system.mcpCatalog)) {
      expect(names.has(key)).toBe(true);
    }
  });

  it.each(dicts)('hints every required env var in %s, and only those', (_locale, dict) => {
    const keys = new Set(BUILTIN_REGISTRY.flatMap((entry) => Object.keys(entry.env)));
    for (const key of keys) {
      expect(dict.toolResult.system.mcpEnvHints[key]).toBeTruthy();
    }
    for (const key of Object.keys(dict.toolResult.system.mcpEnvHints)) {
      expect(keys.has(key)).toBe(true);
    }
  });

  it.each(dicts)('labels every configurable argument in %s', (_locale, dict) => {
    for (const entry of BUILTIN_REGISTRY) {
      for (const slot of entry.configurableArgs ?? []) {
        expect(dict.toolResult.system.mcpArgLabels[`${entry.name}.${slot.index}`]).toBeTruthy();
      }
    }
  });

  it.each(dicts)('carries the browser bridge setup note in %s', (_locale, dict) => {
    expect(dict.toolResult.system.mcpSetupHints['abu-browser-bridge']).toBeTruthy();
  });

  it('resolves argument labels and setup hints through the current locale', () => {
    expect(getArgLabel('postgres', 2)).toBe(
      getI18n().toolResult.system.mcpArgLabels['postgres.2'],
    );
    expect(getArgLabel('postgres', 2)).toBeTruthy();
    expect(getArgLabel('memory', 1)).toBeUndefined();
    expect(getSetupHint('abu-browser-bridge')).toBe(
      getI18n().toolResult.system.mcpSetupHints['abu-browser-bridge'],
    );
    expect(getSetupHint('memory')).toBeUndefined();
  });
});

/**
 * The agent's install path has to reach the same place the marketplace form
 * does. 「市场」 renders a labeled field for every configurable slot, so a user
 * installing postgres there cannot leave the connection string out. The agent
 * has no form — it has an argument list — so an empty slot has to be refused
 * loudly instead of persisting a server that exits the moment it starts.
 */
describe('installMCPServer configurable arguments', () => {
  // The store's actions are replaced wholesale rather than spied on: zustand's
  // immer middleware hands out a new state object per set(), so a vi.spyOn
  // installed on one of them outlives vi.restoreAllMocks() on the next.
  const realAddServer = useMCPStore.getState().addServer;
  const realConnectServer = useMCPStore.getState().connectServer;
  let addServer: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const runtime = globalThis as typeof globalThis & {
      __ABU_SHELL__?: { mainSupervisesSidecar?: boolean };
    };
    runtime.__ABU_SHELL__ = undefined;
    addServer = vi.fn();
    useMCPStore.setState({
      servers: {},
      isLoading: false,
      addServer,
      connectServer: vi.fn(async () => {}),
    });
  });

  afterEach(() => {
    useMCPStore.setState({ addServer: realAddServer, connectServer: realConnectServer });
  });

  const postgres = () => BUILTIN_REGISTRY.find((entry) => entry.name === 'postgres')!;

  it('refuses an unfilled slot by its label, and writes nothing', async () => {
    const result = await installMCPServer(postgres());

    expect(result.success).toBe(false);
    expect(result.message).toContain(getArgLabel('postgres', 2)!);
    expect(addServer).not.toHaveBeenCalled();
  });

  it('fills the slot from args and leaves the registry entry untouched', async () => {
    await installMCPServer(postgres(), undefined, ['postgresql://u:p@h:5432/app']);

    expect(addServer).toHaveBeenCalledWith(expect.objectContaining({
      name: 'postgres',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://u:p@h:5432/app'],
    }));
    // The catalog is shared, module-level state: an install must not leave the
    // previous user's connection string in it.
    expect(postgres().args[2]).toBe('');
  });

  it('carries the entry default timeout into the stored config', async () => {
    const bridge = BUILTIN_REGISTRY.find((entry) => entry.name === 'abu-browser-bridge')!;

    await installMCPServer(bridge);

    expect(addServer).toHaveBeenCalledWith(expect.objectContaining({ timeout: 120000 }));
  });

  it('omits the timeout key entirely for an entry that has no default', async () => {
    const memory = BUILTIN_REGISTRY.find((entry) => entry.name === 'memory')!;

    await installMCPServer(memory);

    expect('timeout' in (addServer.mock.calls[0][0] as object)).toBe(false);
  });

  it('treats an unfilled slot as needs_config, the same as a missing env var', async () => {
    const result = await ensureMCPServer('postgres');

    expect(result.status).toBe('needs_config');
    expect(result.message).toContain(getArgLabel('postgres', 2)!);
    expect(addServer).not.toHaveBeenCalled();
    expect(useMCPStore.getState().servers.postgres).toBeUndefined();
  });
});
