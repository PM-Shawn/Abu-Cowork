import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  probeChromeBridgeConnection,
  readCapabilityRuntimeSnapshot,
} from './runtime';

const isConnected = vi.fn();
const callTool = vi.fn();
const hasElectronCommandHost = vi.fn();

vi.mock('../mcp/client', () => ({
  mcpManager: {
    isConnected: (...args: unknown[]) => isConnected(...args),
    callTool: (...args: unknown[]) => callTool(...args),
  },
}));

vi.mock('../../utils/electronHost', () => ({
  hasElectronCommandHost: () => hasElectronCommandHost(),
}));

describe('readCapabilityRuntimeSnapshot', () => {
  beforeEach(() => {
    isConnected.mockReset();
    callTool.mockReset();
    hasElectronCommandHost.mockReset();
    isConnected.mockReturnValue(true);
    hasElectronCommandHost.mockReturnValue(true);
  });

  it('reads existing runtime state without synthesizing a Chrome configuration', () => {
    const snapshot = readCapabilityRuntimeSnapshot({
      computerUseEnabled: false,
    });

    expect(snapshot).toEqual({
      electronCommandHost: true,
      builtinBrowserConnected: true,
      chromeBridge: {
        configured: false,
        enabled: false,
        status: undefined,
        extensionConnected: undefined,
      },
      computerUse: {
        enabled: false,
        permissions: undefined,
      },
    });
    expect(isConnected).toHaveBeenCalledWith('abu-browser');
  });

  it('projects reactive MCP and permission values unchanged', () => {
    const snapshot = readCapabilityRuntimeSnapshot({
      chromeBridge: {
        enabled: true,
        status: 'reconnecting',
        extensionConnected: false,
      },
      computerUseEnabled: true,
      computerUsePermissions: {
        screenRead: true,
        uiControl: false,
      },
    });

    expect(snapshot.chromeBridge).toEqual({
      configured: true,
      enabled: true,
      status: 'reconnecting',
      extensionConnected: false,
    });
    expect(snapshot.computerUse).toEqual({
      enabled: true,
      permissions: {
        screenRead: true,
        uiControl: false,
      },
    });
  });

  it('probes the extension separately from the MCP process', async () => {
    callTool
      .mockResolvedValueOnce('Browser extension is connected and ready.')
      .mockResolvedValueOnce(
        'Browser extension is not connected. Please install and enable the Abu Browser Extension.',
      )
      .mockResolvedValueOnce(JSON.stringify({ connected: true }));

    await expect(probeChromeBridgeConnection()).resolves.toBe(true);
    await expect(probeChromeBridgeConnection()).resolves.toBe(false);
    await expect(probeChromeBridgeConnection()).resolves.toBe(true);
    expect(callTool).toHaveBeenCalledWith(
      'abu-browser-bridge',
      'connection_status',
      {},
    );
  });

  it('returns unknown when the bridge process or status probe is unavailable', async () => {
    isConnected.mockReturnValueOnce(false);
    await expect(probeChromeBridgeConnection()).resolves.toBeUndefined();
    expect(callTool).not.toHaveBeenCalled();

    isConnected.mockReturnValue(true);
    callTool.mockRejectedValueOnce(new Error('probe failed'));
    await expect(probeChromeBridgeConnection()).resolves.toBeUndefined();
  });
});
