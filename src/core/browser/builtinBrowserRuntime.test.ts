import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hasElectronCommandHost: vi.fn(),
  connectServer: vi.fn(),
  disconnectServer: vi.fn(),
  isConnected: vi.fn(),
}));

vi.mock('../../utils/electronHost', () => ({
  hasElectronCommandHost: mocks.hasElectronCommandHost,
}));

vi.mock('../mcp/client', () => ({
  mcpManager: {
    connectServer: mocks.connectServer,
    disconnectServer: mocks.disconnectServer,
    isConnected: mocks.isConnected,
  },
}));

import {
  BUILTIN_BROWSER_SERVER_NAME,
  cleanupBuiltinBrowserRuntime,
  ensureBuiltinBrowserRuntime,
  initBuiltinBrowserRuntime,
} from './builtinBrowserRuntime';

describe('builtin browser runtime lifecycle', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.hasElectronCommandHost.mockReturnValue(true);
    mocks.isConnected.mockReturnValue(false);
    mocks.connectServer.mockResolvedValue(undefined);
    mocks.disconnectServer.mockResolvedValue(undefined);
    initBuiltinBrowserRuntime();
    await vi.waitFor(() => expect(mocks.connectServer).toHaveBeenCalled());
    vi.clearAllMocks();
  });

  it('uses a private non-persisted MCP identity for the Electron browser', async () => {
    expect(await ensureBuiltinBrowserRuntime()).toBe(true);
    expect(mocks.connectServer).toHaveBeenCalledWith({
      name: BUILTIN_BROWSER_SERVER_NAME,
      transport: 'stdio',
      command: 'abu-browser-runtime',
      args: [],
      env: {},
      enabled: true,
      timeout: 120000,
    });
  });

  it('does not start the Electron runtime on legacy Tauri', async () => {
    await cleanupBuiltinBrowserRuntime();
    vi.clearAllMocks();
    mocks.hasElectronCommandHost.mockReturnValue(false);
    initBuiltinBrowserRuntime();

    expect(await ensureBuiltinBrowserRuntime()).toBe(false);
    expect(mocks.connectServer).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent startup and disconnects during cleanup', async () => {
    await cleanupBuiltinBrowserRuntime();
    vi.clearAllMocks();
    mocks.hasElectronCommandHost.mockReturnValue(true);
    let resolveConnect: (() => void) | undefined;
    mocks.connectServer.mockImplementation(() => new Promise<void>((resolve) => {
      resolveConnect = resolve;
    }));
    initBuiltinBrowserRuntime();
    const second = ensureBuiltinBrowserRuntime();

    expect(mocks.connectServer).toHaveBeenCalledTimes(1);
    resolveConnect?.();
    expect(await second).toBe(true);

    await cleanupBuiltinBrowserRuntime();
    expect(mocks.disconnectServer).toHaveBeenCalledWith(BUILTIN_BROWSER_SERVER_NAME);
  });
});
