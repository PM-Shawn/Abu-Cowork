import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_REGISTRY,
  ELECTRON_CHROME_BRIDGE_COMMAND,
  ensureMCPServer,
  getArgLabel,
  getRegistryEntry,
  getSetupHint,
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
