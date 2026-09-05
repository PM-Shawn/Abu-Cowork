// Threads ToolExecutionContext.conversationId from ToolDefinition.execute()
// through MCPClientManager.callTool() into the MCP request `_meta`, so a
// downstream MCP server (e.g. abu-browser-bridge) can read the owning
// conversation without the model ever seeing it in the tool schema.
//
// Note: vitest.config.ts aliases every `@modelcontextprotocol/sdk/*` submodule
// specifier to the same stub file (src/test/__mocks__/mcp.ts), so
// MCPClientManager.connectServer() can never succeed in this test environment
// (loadMCPSDK() always finds `Client` undefined). These tests therefore drive
// the real callTool() implementation directly, injecting a fake connected
// server the same way src/core/mcp/enterprise-entitlement.test.ts does.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MCPClientManager, toCallToolOpts } from './client';
import type { ToolDefinition } from '../../types';

// Mirrors the private `ConnectedServer` shape in client.ts — not exported
// there, so this test declares just enough of the shape to inject a fake
// connected server (bypassing connectServer(), see file header comment).
interface FakeConnectedServer {
  config: { name: string };
  client: { callTool: ReturnType<typeof vi.fn> };
  transport: unknown;
  tools: Map<string, ToolDefinition>;
}

describe('conversationId threading into MCP _meta', () => {
  let manager: MCPClientManager;
  let mockCallTool: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    manager = new MCPClientManager();
    mockCallTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

    const fakeServer: FakeConnectedServer = {
      config: { name: 'test-server' },
      client: { callTool: mockCallTool },
      transport: {},
      tools: new Map(),
    };
    (manager as unknown as { servers: Map<string, FakeConnectedServer> }).servers.set(
      'test-server',
      fakeServer
    );
  });

  it('includes _meta with the conversation id when callTool() is given a conversationId', async () => {
    await manager.callTool('test-server', 'some_tool', { a: 1 }, { conversationId: 'c1' });

    expect(mockCallTool).toHaveBeenCalledTimes(1);
    const params = mockCallTool.mock.calls[0][0];
    expect(params).toMatchObject({
      name: 'some_tool',
      arguments: { a: 1 },
      _meta: { 'abu/conversationId': 'c1' },
    });
  });

  it('omits _meta entirely when callTool() is given no opts', async () => {
    await manager.callTool('test-server', 'some_tool', { a: 1 });

    expect(mockCallTool).toHaveBeenCalledTimes(1);
    const params = mockCallTool.mock.calls[0][0];
    expect(params).toEqual({ name: 'some_tool', arguments: { a: 1 } });
    expect(params._meta).toBeUndefined();
  });

  it('omits _meta when opts is given but conversationId is empty/undefined', async () => {
    await manager.callTool('test-server', 'some_tool', { a: 1 }, { conversationId: undefined });

    expect(mockCallTool).toHaveBeenCalledTimes(1);
    const params = mockCallTool.mock.calls[0][0];
    expect(params._meta).toBeUndefined();
  });
});

// toCallToolOpts() is the exact mapping the execute() closure built during
// tool discovery (connectServer/refreshServerTools) uses to turn a tool's
// runtime ToolExecutionContext into callTool() opts — see toCallToolOpts's
// call sites in client.ts. It's tested directly here because driving that
// closure end-to-end would require a real MCP SDK connection, which the test
// environment stubs out (see the file header comment above).
describe('toCallToolOpts', () => {
  it('carries conversationId from context into opts', () => {
    expect(toCallToolOpts({ conversationId: 'c1' })).toEqual({
      conversationId: 'c1',
      signal: undefined,
    });
  });

  it('returns conversationId: undefined when context has none', () => {
    expect(toCallToolOpts({})).toEqual({ conversationId: undefined, signal: undefined });
  });

  it('returns conversationId: undefined when context itself is undefined', () => {
    expect(toCallToolOpts(undefined)).toEqual({ conversationId: undefined, signal: undefined });
  });

  it('carries abortSignal from context into opts.signal', () => {
    const controller = new AbortController();
    expect(toCallToolOpts({ abortSignal: controller.signal })).toEqual({
      conversationId: undefined,
      signal: controller.signal,
    });
  });
});

// Task B1: the conversation run's AbortSignal (ToolExecutionContext.abortSignal,
// threaded through toCallToolOpts()/executeAnyTool's opts) is passed to the MCP
// SDK's client.callTool() as its RequestOptions.signal (3rd positional param) —
// see the SDK's client/index.d.ts: callTool(params, resultSchema?, options?).
// Passing it makes the SDK itself send `notifications/cancelled` and reject
// promptly when the signal fires; this suite proves the plumbing, not the SDK's
// internal cancellation (that's the sdk's own tested behavior).
describe('abort signal propagation into MCP callTool', () => {
  let manager: MCPClientManager;
  let mockCallTool: ReturnType<typeof vi.fn>;

  function setFakeServer(name: string): void {
    const fakeServer: FakeConnectedServer = {
      config: { name },
      client: { callTool: mockCallTool },
      transport: {},
      tools: new Map(),
    };
    (manager as unknown as { servers: Map<string, FakeConnectedServer> }).servers.set(
      name,
      fakeServer
    );
  }

  beforeEach(() => {
    manager = new MCPClientManager();
    mockCallTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    setFakeServer('test-server');
  });

  it('passes opts.signal through to the SDK callTool as RequestOptions (3rd param)', async () => {
    const controller = new AbortController();

    await manager.callTool('test-server', 'some_tool', { a: 1 }, { signal: controller.signal });

    expect(mockCallTool).toHaveBeenCalledWith(
      { name: 'some_tool', arguments: { a: 1 } },
      undefined,
      { signal: controller.signal, timeout: 30000 }
    );
  });

  // Task B2 (controller addendum): the SDK's own request/response cycle has
  // an internal default request timeout (60s, DEFAULT_REQUEST_TIMEOUT_MSEC)
  // that used to fire independently of the manual Promise.race above it —
  // for a browser server, whose manual race allows 120s, that meant the
  // SDK's internal 60s timeout could reject a long `wait_for` first. Passing
  // `timeout: serverTimeout` aligns the SDK's own timeout with the race.
  it('always passes options.timeout (serverTimeout) to the SDK, signal or not', async () => {
    await manager.callTool('test-server', 'some_tool', { a: 1 });

    expect(mockCallTool).toHaveBeenCalledWith(
      { name: 'some_tool', arguments: { a: 1 } },
      undefined,
      { timeout: 30000 }
    );
  });

  it('passes options.timeout=120000 for a browser server (120s manual race)', async () => {
    setFakeServer('abu-browser');

    await manager.callTool('abu-browser', 'wait_for', { tabId: 1 });

    expect(mockCallTool).toHaveBeenCalledWith(
      { name: 'wait_for', arguments: { tabId: 1 } },
      undefined,
      { timeout: 120000 }
    );
  });

  it('resolves normally when the signal is provided but never aborted', async () => {
    const controller = new AbortController();

    const result = await manager.callTool(
      'test-server',
      'some_tool',
      { a: 1 },
      { signal: controller.signal }
    );

    expect(result).toBe('ok');
  });

  it('rejects promptly with the normalized browser-cancel message when the tool belongs to a browser server and the signal is aborted', async () => {
    setFakeServer('abu-browser');
    const controller = new AbortController();
    controller.abort();
    // Simulates the MCP SDK's own abort handling (protocol.ts): an aborted
    // signal causes the SDK's callTool() promise to reject promptly.
    mockCallTool.mockRejectedValue(new DOMException('This operation was aborted', 'AbortError'));

    await expect(
      manager.callTool('abu-browser', 'click', {}, { signal: controller.signal })
    ).rejects.toThrow('Browser action cancelled because the run was stopped.');
  });

  it('applies the same normalization for the abu-browser-bridge server', async () => {
    setFakeServer('abu-browser-bridge');
    const controller = new AbortController();
    controller.abort();
    mockCallTool.mockRejectedValue(new DOMException('This operation was aborted', 'AbortError'));

    await expect(
      manager.callTool('abu-browser-bridge', 'click', {}, { signal: controller.signal })
    ).rejects.toThrow('Browser action cancelled because the run was stopped.');
  });

  it('keeps the SDK error message unnormalized for non-browser MCP servers even when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    mockCallTool.mockRejectedValue(new DOMException('This operation was aborted', 'AbortError'));

    await expect(
      manager.callTool('test-server', 'some_tool', {}, { signal: controller.signal })
    ).rejects.toThrow(/Tool call failed: This operation was aborted/);
  });

  it('does not normalize a browser server error when the signal was never aborted (real failure stays real)', async () => {
    setFakeServer('abu-browser');
    mockCallTool.mockRejectedValue(new Error('boom'));

    await expect(manager.callTool('abu-browser', 'click', {}, {})).rejects.toThrow(/boom/);
  });
});

/**
 * The run-settlement notification: how the Chrome bridge learns a run is over
 * and releases the browser tabs that run claimed.
 *
 * It exists because the bridge's only other signal is a per-REQUEST abort, and
 * the MCP SDK raises that for its own request timeouts — so acting on it hands
 * a still-running task's page to another conversation. The scope rule matters
 * as much as the delivery: the notification always names ONE run, because the
 * release protocol reads a missing run key as "every run of this conversation".
 */
describe('browser bridge run-settled notification', () => {
  let manager: MCPClientManager;
  let mockCallTool: ReturnType<typeof vi.fn>;
  let mockNotification: ReturnType<typeof vi.fn>;

  function setFakeServer(name: string): void {
    const fakeServer = {
      config: { name },
      client: { callTool: mockCallTool, notification: mockNotification, close: vi.fn() },
      transport: {},
      tools: new Map(),
    };
    (manager as unknown as { servers: Map<string, unknown> }).servers.set(name, fakeServer);
  }

  /** One settlement's worth of arguments, for readable assertions. */
  function settledParams() {
    return mockNotification.mock.calls.map((call) => call[0]);
  }

  beforeEach(() => {
    manager = new MCPClientManager();
    mockCallTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    mockNotification = vi.fn().mockResolvedValue(undefined);
    setFakeServer('abu-browser-bridge');
  });

  it("names the conversation's own loop as `main`, never as the bare conversation", async () => {
    await manager.callTool('abu-browser-bridge', 'click', {}, { conversationId: 'conv-1' });

    manager.notifyBrowserBridgeRunSettled('conv-1');

    expect(settledParams()).toEqual([
      {
        method: 'notifications/abu/runSettled',
        params: { ownerId: 'conv-1', runId: 'main' },
      },
    ]);
  });

  it('names the subagent run that settled', async () => {
    await manager.callTool(
      'abu-browser-bridge',
      'click',
      {},
      { conversationId: 'conv-1', agentRunId: 'sar-9' },
    );

    manager.notifyBrowserBridgeRunSettled('conv-1', 'sar-9');

    expect(settledParams()).toEqual([
      {
        method: 'notifications/abu/runSettled',
        params: { ownerId: 'conv-1', runId: 'sar-9' },
      },
    ]);
  });

  it('says nothing for a run that never touched the bridge', () => {
    manager.notifyBrowserBridgeRunSettled('conv-1');
    manager.notifyBrowserBridgeRunSettled('conv-1', 'sar-9');

    // Most runs never open a browser; waking the bridge for each of them would
    // be pure noise, and there is no claim to release anyway.
    expect(mockNotification).not.toHaveBeenCalled();
  });

  it('does not let one run\'s settlement speak for a sibling run', async () => {
    await manager.callTool(
      'abu-browser-bridge',
      'click',
      {},
      { conversationId: 'conv-1', agentRunId: 'sar-9' },
    );

    // The main loop settles first; only the delegation drove the browser.
    manager.notifyBrowserBridgeRunSettled('conv-1');

    expect(mockNotification).not.toHaveBeenCalled();
  });

  it('is not armed by a call to a different MCP server', async () => {
    setFakeServer('some-other-server');

    await manager.callTool('some-other-server', 'click', {}, { conversationId: 'conv-1' });
    manager.notifyBrowserBridgeRunSettled('conv-1');

    expect(mockNotification).not.toHaveBeenCalled();
  });

  it('arms on a bridge call that failed, since the tab was already claimed', async () => {
    mockCallTool.mockRejectedValueOnce(new Error('boom'));
    await expect(
      manager.callTool('abu-browser-bridge', 'click', {}, { conversationId: 'conv-1' }),
    ).rejects.toThrow(/boom/);

    manager.notifyBrowserBridgeRunSettled('conv-1');

    expect(mockNotification).toHaveBeenCalledTimes(1);
  });

  it('sends one notification per run, however often the seal is reached', async () => {
    await manager.callTool('abu-browser-bridge', 'click', {}, { conversationId: 'conv-1' });

    manager.notifyBrowserBridgeRunSettled('conv-1');
    manager.notifyBrowserBridgeRunSettled('conv-1');

    expect(mockNotification).toHaveBeenCalledTimes(1);
  });

  it('does not throw when the bridge is not connected', async () => {
    await manager.callTool('abu-browser-bridge', 'click', {}, { conversationId: 'conv-1' });
    (manager as unknown as { servers: Map<string, unknown> }).servers.delete('abu-browser-bridge');

    // Releasing is best-effort: the seal fires without first asking whether
    // the bridge process is still there.
    expect(() => manager.notifyBrowserBridgeRunSettled('conv-1')).not.toThrow();
    expect(mockNotification).not.toHaveBeenCalled();
  });

  it('does not throw when the notification itself fails', async () => {
    await manager.callTool('abu-browser-bridge', 'click', {}, { conversationId: 'conv-1' });
    mockNotification.mockRejectedValueOnce(new Error('transport gone'));

    expect(() => manager.notifyBrowserBridgeRunSettled('conv-1')).not.toThrow();
    await Promise.resolve();
  });

  it('forgets armed runs once the bridge disconnects, claims and all', async () => {
    await manager.callTool('abu-browser-bridge', 'click', {}, { conversationId: 'conv-1' });

    await manager.disconnectServer('abu-browser-bridge');
    // A reconnected bridge is a new process whose extension socket dropped
    // every claim; telling it about runs from the old one is meaningless.
    setFakeServer('abu-browser-bridge');
    manager.notifyBrowserBridgeRunSettled('conv-1');

    expect(mockNotification).not.toHaveBeenCalled();
  });

  it('says nothing without a conversation to name', () => {
    manager.notifyBrowserBridgeRunSettled(undefined);
    manager.notifyBrowserBridgeRunSettled('');

    expect(mockNotification).not.toHaveBeenCalled();
  });
});
