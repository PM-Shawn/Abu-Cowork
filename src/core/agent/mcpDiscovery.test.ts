import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ELECTRON_CHROME_BRIDGE_COMMAND,
  ensureMCPServer,
  getRegistryEntry,
  provisionFirstPartyMCPServers,
  resolveMCPCompanionResource,
} from './mcpDiscovery';
import { useMCPStore } from '../../stores/mcpStore';

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
