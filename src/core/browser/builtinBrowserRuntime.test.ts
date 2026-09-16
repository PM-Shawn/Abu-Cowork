import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  waitForBuiltinBrowserTools,
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

/**
 * #389 — the readiness a caller needs BEFORE it freezes a tool roster.
 *
 * A scheduled run snapshots the reachable tools at dispatch. `abu-browser`
 * connects asynchronously after every renderer load, and the scheduler ticks
 * immediately at start to catch up missed tasks, so the snapshot could be
 * taken mid-handshake and freeze "there is no browser" into the whole run.
 * These pin the three answers that decide what the run reports.
 */
describe('waitForBuiltinBrowserTools', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.hasElectronCommandHost.mockReturnValue(true);
    mocks.isConnected.mockReturnValue(false);
    mocks.connectServer.mockResolvedValue(undefined);
    mocks.disconnectServer.mockResolvedValue(undefined);
    // Settle whatever the previous describe left in flight, then take the
    // module out of its stopped state with a connect that has fully resolved
    // — so each test below starts from "nothing pending".
    await cleanupBuiltinBrowserRuntime();
    initBuiltinBrowserRuntime();
    await ensureBuiltinBrowserRuntime();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers ready with no wait at all when the runtime is already connected', async () => {
    mocks.isConnected.mockReturnValue(true);
    // Fake timers that are never advanced: anything that actually waited on a
    // timer here would hang instead of resolving. This is the normal 9am run,
    // and it must not pay for the startup race.
    vi.useFakeTimers();

    await expect(waitForBuiltinBrowserTools({ timeoutMs: 15_000 })).resolves.toBe('ready');
    expect(mocks.connectServer).not.toHaveBeenCalled();
  });

  it('waits for a connect that is still in flight and then reports ready', async () => {
    let resolveConnect: (() => void) | undefined;
    mocks.connectServer.mockImplementation(() => new Promise<void>((resolve) => {
      resolveConnect = resolve;
    }));
    vi.useFakeTimers();

    const pending = waitForBuiltinBrowserTools({ timeoutMs: 15_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    resolveConnect?.();

    await expect(pending).resolves.toBe('ready');
  });

  it('gives up at the caller budget instead of hanging an unattended run', async () => {
    let resolveConnect: (() => void) | undefined;
    mocks.connectServer.mockImplementation(() => new Promise<void>((resolve) => {
      resolveConnect = resolve;
    }));
    vi.useFakeTimers();

    const pending = waitForBuiltinBrowserTools({ timeoutMs: 15_000 });
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(pending).resolves.toBe('not-ready');
    // The connect is NOT cancelled — the dispatch that follows, and the next
    // run, still get the runtime the moment it finishes.
    expect(mocks.connectServer).toHaveBeenCalledTimes(1);
    resolveConnect?.();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('reports a failed connect as not ready, not as a host without a browser', async () => {
    // The difference matters downstream: 'not-ready' is a fact the run tells
    // the user about, 'unavailable' is a capability that never existed here.
    mocks.connectServer.mockRejectedValue(new Error('spawn failed'));

    await expect(waitForBuiltinBrowserTools({ timeoutMs: 15_000 })).resolves.toBe('not-ready');
  });

  it('answers unavailable — immediately — on a host with no built-in browser', async () => {
    mocks.hasElectronCommandHost.mockReturnValue(false);
    vi.useFakeTimers();

    await expect(waitForBuiltinBrowserTools({ timeoutMs: 15_000 })).resolves.toBe('unavailable');
    expect(mocks.connectServer).not.toHaveBeenCalled();
  });
});
