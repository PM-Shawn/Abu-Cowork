// Proves the full chain executeAnyTool() → mcpManager.callTool() → MCP `_meta`
// for a real model tool_use of an MCP-formatted tool name (serverName__toolName).
// This is the path toolExecutor.ts actually calls for every tool_use — unlike
// src/core/mcp/client.test.ts, which only covers the last hop (callTool() /
// the ToolDefinition.execute() closures built during tool discovery), this
// test drives executeAnyTool() itself and asserts the request that reaches
// the (fake) underlying MCP SDK client carries `_meta`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeAnyTool } from './registry';
import { mcpManager } from '../mcp/client';
import type { ToolDefinition } from '../../types';
import { useChatStore } from '../../stores/chatStore';
import { setMigratedBrowserSettings } from '@/test/migratedBrowserSettings';
import { __resetBrowserGrantsForTests } from '../permissions/browserToolPolicy';

// Mirrors the private `ConnectedServer` shape in client.ts — not exported
// there (see src/core/mcp/client.test.ts for the same injection technique,
// and src/core/mcp/enterprise-entitlement.test.ts for the precedent of
// testing mcpManager via its real, unmocked singleton).
interface FakeConnectedServer {
  config: { name: string };
  client: { callTool: ReturnType<typeof vi.fn> };
  transport: unknown;
  tools: Map<string, ToolDefinition>;
  appTools: Map<string, ToolDefinition>;
}

describe('executeAnyTool → mcpManager.callTool → _meta (MCP tool dispatch)', () => {
  let mockCallTool: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockCallTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

    const fakeServer: FakeConnectedServer = {
      config: { name: 'test-server' },
      client: { callTool: mockCallTool },
      transport: {},
      appTools: new Map(),
      tools: new Map(),
    };
    (mcpManager as unknown as { servers: Map<string, FakeConnectedServer> }).servers.set(
      'test-server',
      fakeServer
    );
  });

  afterEach(() => {
    (mcpManager as unknown as { servers: Map<string, FakeConnectedServer> }).servers.delete(
      'test-server'
    );
  });

  it('forwards the conversation id from ToolExecutionContext into the MCP request _meta', async () => {
    const result = await executeAnyTool(
      'test-server__test_tool',
      { a: 1 },
      undefined,
      undefined,
      { conversationId: 'c1' }
    );

    expect(result).toBe('ok');
    expect(mockCallTool).toHaveBeenCalledTimes(1);
    const params = mockCallTool.mock.calls[0][0];
    expect(params).toMatchObject({
      name: 'test_tool',
      arguments: { a: 1 },
      _meta: { 'abu/conversationId': 'c1' },
    });
  });

  // N6: browser tab ownership is the pair {conversationId, runKey}, so a
  // subagent run's id has to reach the server the same way its conversation id
  // does — through `_meta`, never through the tool's input schema (the model
  // must not see, or be able to forge, either half).
  it('forwards the subagent run id from ToolExecutionContext into the MCP request _meta', async () => {
    await executeAnyTool('test-server__test_tool', { a: 1 }, undefined, undefined, {
      conversationId: 'c1',
      agentRunId: 'sar-xyz',
    });

    expect(mockCallTool).toHaveBeenCalledTimes(1);
    expect(mockCallTool.mock.calls[0][0]).toMatchObject({
      name: 'test_tool',
      arguments: { a: 1 },
      _meta: { 'abu/conversationId': 'c1', 'abu/runKey': 'sar-xyz' },
    });
  });

  // Degenerate-case compat: the main loop sends no run id, and its request must
  // stay byte-identical to what it was before N6 — the host owns the
  // "absent ⇒ main" default.
  it('omits the run key entirely for a main-loop call', async () => {
    await executeAnyTool('test-server__test_tool', { a: 1 }, undefined, undefined, {
      conversationId: 'c1',
    });

    expect(mockCallTool.mock.calls[0][0]._meta).toEqual({ 'abu/conversationId': 'c1' });
  });

  // The other half of the main-loop neutralization (agentLoopRunner's
  // `contextForSession` sets `agentRunId: undefined` to overwrite a
  // sidecar-supplied one). That leaves the property PRESENT with an undefined
  // value, so this pins the last hop: a neutralized run id must produce no
  // `abu/runKey` at all — an `abu/runKey: undefined` on the wire would reach
  // the host as a malformed owner half rather than as "the main loop".
  it('emits no run key when the context carries an explicitly neutralized agentRunId', async () => {
    await executeAnyTool('test-server__test_tool', { a: 1 }, undefined, undefined, {
      conversationId: 'c1',
      agentRunId: undefined,
    });

    expect(mockCallTool.mock.calls[0][0]._meta).toEqual({ 'abu/conversationId': 'c1' });
  });

  it('omits _meta when the run has no conversationId in context', async () => {
    await executeAnyTool('test-server__test_tool', { a: 1 }, undefined, undefined, undefined);

    expect(mockCallTool).toHaveBeenCalledTimes(1);
    const params = mockCallTool.mock.calls[0][0];
    expect(params._meta).toBeUndefined();
  });

  // Task B1: ToolExecutionContext.abortSignal (already injected by toolExecutor
  // at every dispatch site) must reach the underlying MCP SDK client.callTool()
  // as its RequestOptions.signal (3rd positional param), the same way
  // conversationId reaches `_meta` above — this is the real dispatch path a
  // model tool_use goes through, not just the last-hop unit in client.test.ts.
  it('forwards the abort signal from ToolExecutionContext into the MCP request options', async () => {
    const controller = new AbortController();

    await executeAnyTool('test-server__test_tool', { a: 1 }, undefined, undefined, {
      conversationId: 'c1',
      abortSignal: controller.signal,
    });

    expect(mockCallTool).toHaveBeenCalledTimes(1);
    expect(mockCallTool).toHaveBeenCalledWith(
      { name: 'test_tool', arguments: { a: 1 }, _meta: { 'abu/conversationId': 'c1' } },
      undefined,
      { signal: controller.signal, timeout: 30000 }
    );
  });

  // Task B2 (controller addendum): `timeout: serverTimeout` is always passed
  // to the SDK now (not only alongside a signal) — see client.test.ts's
  // "always passes options.timeout" for why: the SDK's own internal request
  // timeout otherwise fires ahead of callTool's manual race.
  it('still passes options.timeout when the context has no abort signal', async () => {
    await executeAnyTool('test-server__test_tool', { a: 1 }, undefined, undefined, {
      conversationId: 'c1',
    });

    expect(mockCallTool).toHaveBeenCalledWith(
      { name: 'test_tool', arguments: { a: 1 }, _meta: { 'abu/conversationId': 'c1' } },
      undefined,
      { timeout: 30000 }
    );
  });
});

// Screenshot file delivery: a non-vision model cannot consume the image block
// a screenshot tool returns — the adapter strips it on the way out anyway. The
// executor stamps `screenshotDelivery: 'file'` onto the call opts (which
// client.ts maps into `_meta`), keyed on ToolExecutionContext.supportsVision.
// A vision-capable call — or one whose context says nothing — keeps the exact
// pre-existing shape. Same fake-browser-host technique as
// registry.browserDialogGate.test.ts, because `screenshot` is a READ-classified
// browser tool and has to pass the same gate before the dispatch happens.
describe('executeAnyTool stamps screenshotDelivery for non-vision models', () => {
  const OWNER = 'conv-shot';
  const TAB = 41;
  const SITE = 'https://erp.example.com';
  let mockCallTool: ReturnType<typeof vi.fn>;
  // `screenshot` is a browser-classified tool, so in standard permission mode
  // the gate wants a confirmation channel — hand it one that always allows.
  const confirm = vi.fn().mockResolvedValue(true);

  beforeEach(() => {
    mockCallTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const listCall = vi.fn().mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({ windows: [{ windowId: 1, tabs: [{ tabId: TAB, url: `${SITE}/form` }] }] }),
      }],
    });
    const fakeServer: FakeConnectedServer = {
      config: { name: 'abu-browser' },
      client: { callTool: vi.fn((...args: unknown[]) => (
        (args[0] as { name?: string }).name === 'get_tabs' ? listCall() : mockCallTool(...(args as []))
      )) },
      transport: {},
      tools: new Map(),
      appTools: new Map(),
    };
    (mcpManager as unknown as { servers: Map<string, FakeConnectedServer> }).servers.set(
      'abu-browser',
      fakeServer
    );
    useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null });
    setMigratedBrowserSettings({ permissionMode: 'standard', browserSitePermissions: {} });
    __resetBrowserGrantsForTests();
  });

  afterEach(() => {
    (mcpManager as unknown as { servers: Map<string, FakeConnectedServer> }).servers.delete('abu-browser');
    __resetBrowserGrantsForTests();
  });

  it.each(['screenshot', 'screenshot_full_page'])('%s: supportsVision:false delivers as a file', async (toolName) => {
    const result = await executeAnyTool(`abu-browser__${toolName}`, { tabId: TAB }, confirm, undefined, {
      conversationId: OWNER,
      supportsVision: false,
    });

    expect(result).toBe('ok');
    // The executor's opts are consumed inside mcpManager.callTool, which maps
    // them into `_meta` on the params — the same flight as the conversationId
    // pin above.
    const params = mockCallTool.mock.calls[0][0];
    expect(params._meta).toMatchObject({ 'abu/screenshotDelivery': 'file' });
  });

  it.each([
    ['a vision-capable model', true],
    ['a context with no vision flag', undefined],
  ])('%s keeps the pre-existing opts shape', async (_label, supportsVision) => {
    await executeAnyTool('abu-browser__screenshot', { tabId: TAB }, confirm, undefined, {
      conversationId: OWNER,
      ...(supportsVision !== undefined ? { supportsVision } : {}),
    });

    const params = mockCallTool.mock.calls[0][0];
    expect(params._meta).not.toHaveProperty('abu/screenshotDelivery');
  });
});
