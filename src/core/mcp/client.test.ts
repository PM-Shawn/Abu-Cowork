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
});
