/**
 * Contract check for the MCP App demo fixture.
 *
 * The Electron E2E can only fail *after* the server has been spawned, connected
 * and driven through a model turn — a slow, noisy way to learn that the fixture
 * declares its `_meta.ui` wrong. This boots the same server over an in-memory
 * transport and asserts the three things Abu's host actually reads: the tools'
 * `_meta.ui`, the resource's MCP-App MIME type, and `structuredContent`.
 *
 * The client side is hand-rolled JSON-RPC rather than the SDK `Client`, because
 * `vitest.config.ts` aliases `@modelcontextprotocol/sdk/client/index.js` to a
 * stub for every other test in the repo.
 */
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  EVIL_RESOURCE_URI,
  TABLE_RESOURCE_URI,
  buildRows,
  createDemoServer,
  summarizeRows,
} from './demoServer.ts';

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface ToolListing {
  name: string;
  inputSchema?: Record<string, unknown>;
  _meta?: { ui?: { resourceUri?: string; visibility?: string[] } };
}

interface ResourceContent {
  uri?: string;
  mimeType?: string;
  text?: string;
  _meta?: { ui?: Record<string, unknown> };
}

/** Minimal JSON-RPC caller over the client half of a linked in-memory pair. */
function createCaller(transport: InMemoryTransport) {
  let nextId = 0;
  const waiting = new Map<number, (response: JsonRpcResponse) => void>();
  transport.onmessage = (message) => {
    const response = message as unknown as JsonRpcResponse;
    const settle = waiting.get(response.id);
    if (!settle) return;
    waiting.delete(response.id);
    settle(response);
  };
  return {
    async call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
      const id = ++nextId;
      const response = await new Promise<JsonRpcResponse>((resolve) => {
        waiting.set(id, resolve);
        void transport.send({ jsonrpc: '2.0', id, method, params });
      });
      if (response.error) throw new Error(`${method} failed: ${response.error.message}`);
      return response.result ?? {};
    },
    notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
      return transport.send({ jsonrpc: '2.0', method, params });
    },
  };
}

describe('mcp-app-demo fixture server', () => {
  let caller: ReturnType<typeof createCaller>;

  beforeAll(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createDemoServer();
    await server.connect(serverTransport);
    await clientTransport.start();
    caller = createCaller(clientTransport);
    await caller.call('initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'mcp-app-demo-test', version: '1.0.0' },
    });
    await caller.notify('notifications/initialized');
  });

  describe('tools/list', () => {
    it('declares _meta.ui on every app tool, with the right visibility', async () => {
      const result = await caller.call('tools/list');
      const tools = result.tools as ToolListing[];
      const byName = new Map(tools.map((tool) => [tool.name, tool]));

      expect(byName.get('show_table')?._meta?.ui).toMatchObject({
        resourceUri: TABLE_RESOURCE_URI,
        visibility: ['model', 'app'],
      });
      // App-only: Abu keeps this one out of the model's tool table entirely.
      expect(byName.get('refresh_rows')?._meta?.ui).toMatchObject({
        resourceUri: TABLE_RESOURCE_URI,
        visibility: ['app'],
      });
      expect(byName.get('show_evil')?._meta?.ui).toMatchObject({
        resourceUri: EVIL_RESOURCE_URI,
      });
    });
  });

  describe('resources/read', () => {
    it('serves the table interface as an MCP App document with its CSP metadata', async () => {
      const result = await caller.call('resources/read', { uri: TABLE_RESOURCE_URI });
      const contents = result.contents as ResourceContent[];
      const content = contents.find((entry) => entry.uri === TABLE_RESOURCE_URI);

      expect(content?.mimeType).toBe('text/html;profile=mcp-app');
      expect(content?.text).toContain('data-testid="demo-refresh"');
      // Read off the CONTENT item, which is where Abu's host looks.
      expect(content?._meta?.ui).toMatchObject({
        prefersBorder: true,
        csp: { connectDomains: [] },
      });
    });

    it('serves the hostile interface with the domains the host must refuse', async () => {
      const result = await caller.call('resources/read', { uri: EVIL_RESOURCE_URI });
      const contents = result.contents as ResourceContent[];
      const content = contents.find((entry) => entry.uri === EVIL_RESOURCE_URI);

      expect(content?.mimeType).toBe('text/html;profile=mcp-app');
      expect(content?._meta?.ui).toMatchObject({
        csp: { connectDomains: ['*', 'http://evil.example', 'https://ok.example'] },
      });
    });
  });

  describe('tools/call', () => {
    it('returns structuredContent rows alongside the text summary', async () => {
      const result = await caller.call('tools/call', { name: 'show_table', arguments: {} });

      expect(result.structuredContent).toEqual({ seed: 0, rows: buildRows(0) });
      expect(JSON.stringify(result.content)).toContain(summarizeRows(buildRows(0)));
    });

    it('moves every row when the seed changes, so a refresh is observable', async () => {
      const result = await caller.call('tools/call', {
        name: 'refresh_rows',
        arguments: { seed: 7 },
      });

      expect(result.structuredContent).toEqual({ seed: 7, rows: buildRows(7) });
      expect(buildRows(7).map((row) => row.value)).toEqual([107, 207, 307]);
    });
  });
});
