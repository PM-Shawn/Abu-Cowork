// MCP Apps (io.modelcontextprotocol/ui) discovery + resource reads.
// The SDK Client is replaced with a deterministic fake: no child processes,
// no network, no timers — connectServer's stdio path only constructs a
// TauriStdioTransport (start() is never called by the fake client).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResourceListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

type FakeTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

type FakeResourceContents = {
  contents?: Array<{ uri?: string; mimeType?: string; text?: string; blob?: string }>;
};

const mcpMock = vi.hoisted(() => {
  const state = {
    tools: [] as FakeTool[],
    readCalls: [] as string[],
    readResource: (uri: string): Promise<unknown> =>
      Promise.resolve({ contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: '<h1>hi</h1>' }] }),
    notificationHandlers: [] as Array<{ schema: unknown; handler: (n: unknown) => void }>,
    closed: 0,
  };

  class FakeClient {
    async connect(): Promise<void> {}
    async close(): Promise<void> {
      state.closed += 1;
    }
    async listTools(): Promise<{ tools: FakeTool[] }> {
      return { tools: state.tools };
    }
    async readResource(params: { uri: string }): Promise<unknown> {
      state.readCalls.push(params.uri);
      return state.readResource(params.uri);
    }
    setNotificationHandler(schema: unknown, handler: (n: unknown) => void): void {
      state.notificationHandlers.push({ schema, handler });
    }
  }

  return { state, FakeClient };
});

// Overrides the global `() => ({})` stub from src/test/setup.ts so connectServer
// can actually run.
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: mcpMock.FakeClient }));

const { state } = mcpMock;

import { mcpManager } from './client';
import { MAX_APP_RESOURCE_BYTES } from './appResources';

const SERVER = 'ui-server';

function tool(name: string, meta?: Record<string, unknown>): FakeTool {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    ...(meta ? { _meta: meta } : {}),
  };
}

async function connect(tools: FakeTool[], name = SERVER): Promise<void> {
  state.tools = tools;
  await mcpManager.connectServer({ name, command: 'echo', args: [] });
}

beforeEach(() => {
  state.tools = [];
  state.readCalls = [];
  state.notificationHandlers = [];
  state.closed = 0;
  state.readResource = (uri: string) =>
    Promise.resolve({ contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: '<h1>hi</h1>' }] });
});

afterEach(async () => {
  await mcpManager.disconnectAll();
});

describe('MCP Apps discovery (_meta.ui)', () => {
  it('keeps _meta.ui on the tool definition', async () => {
    await connect([tool('board', { ui: { resourceUri: 'ui://board/main.html', visibility: ['model', 'app'] } })]);

    const def = mcpManager.getServerTools(SERVER).find((t) => t.name === `${SERVER}__board`);
    expect(def?.ui).toEqual({ resourceUri: 'ui://board/main.html', visibility: ['model', 'app'] });
  });

  it('ignores a resourceUri that is not a ui:// URI', async () => {
    await connect([
      tool('a', { ui: { resourceUri: 'https://evil.example/app.html' } }),
      tool('b', { ui: { resourceUri: 42 } }),
      tool('c', { ui: 'nope' }),
      tool('d', {}),
    ]);

    for (const name of ['a', 'b', 'c', 'd']) {
      const def = mcpManager.getServerTools(SERVER).find((t) => t.name === `${SERVER}__${name}`);
      expect(def, name).toBeDefined();
      expect(def?.ui, name).toBeUndefined();
    }
  });

  it('defaults visibility to model+app when absent, empty or malformed', async () => {
    await connect([
      tool('absent', { ui: { resourceUri: 'ui://x/1.html' } }),
      tool('empty', { ui: { resourceUri: 'ui://x/2.html', visibility: [] } }),
      tool('malformed', { ui: { resourceUri: 'ui://x/3.html', visibility: 'model' } }),
      tool('unknownOnly', { ui: { resourceUri: 'ui://x/4.html', visibility: ['weird'] } }),
    ]);

    for (const name of ['absent', 'empty', 'malformed', 'unknownOnly']) {
      const def = mcpManager.getServerTools(SERVER).find((t) => t.name === `${SERVER}__${name}`);
      expect(def?.ui?.visibility, name).toEqual(['model', 'app']);
    }
  });

  it('filters unknown visibility values but keeps the known ones', async () => {
    await connect([tool('mixed', { ui: { resourceUri: 'ui://x/5.html', visibility: ['app', 'nope', 'model', 7] } })]);

    const def = mcpManager.getServerTools(SERVER).find((t) => t.name === `${SERVER}__mixed`);
    expect(def?.ui?.visibility).toEqual(['app', 'model']);
  });
});

describe('app-only tools', () => {
  it('keeps app-only tools out of the model tool table but reachable via getAppTool', async () => {
    await connect([
      tool('modelTool', { ui: { resourceUri: 'ui://x/1.html', visibility: ['model', 'app'] } }),
      tool('appOnly', { ui: { resourceUri: 'ui://x/2.html', visibility: ['app'] } }),
    ]);

    const modelNames = mcpManager.listTools().map((t) => t.name);
    expect(modelNames).toContain(`${SERVER}__modelTool`);
    expect(modelNames).not.toContain(`${SERVER}__appOnly`);

    expect(mcpManager.getServerTools(SERVER).map((t) => t.name)).not.toContain(`${SERVER}__appOnly`);
    expect(mcpManager.getStatus().find((s) => s.name === SERVER)?.tools).toEqual(['modelTool']);

    const appTool = mcpManager.getAppTool(SERVER, 'appOnly');
    expect(appTool?.name).toBe(`${SERVER}__appOnly`);
    expect(appTool?.ui?.visibility).toEqual(['app']);
  });

  it('does not duplicate model-visible tools into appTools', async () => {
    await connect([tool('both', { ui: { resourceUri: 'ui://x/1.html', visibility: ['model', 'app'] } })]);

    expect(mcpManager.getAppTool(SERVER, 'both')).toBeUndefined();
    expect(mcpManager.getAppTool(SERVER, 'missing')).toBeUndefined();
    expect(mcpManager.getAppTool('nope', 'both')).toBeUndefined();
  });
});

describe('readResource', () => {
  it('reads a ui:// resource and flags MCP App HTML', async () => {
    await connect([]);
    const res = await mcpManager.readResource(SERVER, 'ui://x/1.html');
    expect(res).toEqual({ mimeType: 'text/html;profile=mcp-app', text: '<h1>hi</h1>', isMcpApp: true });
  });

  it('returns isMcpApp=false for plain HTML', async () => {
    await connect([]);
    state.readResource = (uri) => Promise.resolve({ contents: [{ uri, mimeType: 'text/html', text: '<p>x</p>' }] });

    const res = await mcpManager.readResource(SERVER, 'ui://x/plain.html');
    expect(res.isMcpApp).toBe(false);
    expect(res.text).toBe('<p>x</p>');
  });

  it('caches by server+uri', async () => {
    await connect([]);
    await mcpManager.readResource(SERVER, 'ui://x/1.html');
    await mcpManager.readResource(SERVER, 'ui://x/1.html');
    expect(state.readCalls).toEqual(['ui://x/1.html']);

    await mcpManager.readResource(SERVER, 'ui://x/2.html');
    expect(state.readCalls).toHaveLength(2);
  });

  it('shares one in-flight read between concurrent callers', async () => {
    await connect([]);
    let release: (() => void) | undefined;
    state.readResource = (uri) =>
      new Promise((resolve) => {
        release = () => resolve({ contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: 'ok' }] });
      });

    const a = mcpManager.readResource(SERVER, 'ui://x/1.html');
    const b = mcpManager.readResource(SERVER, 'ui://x/1.html');
    release!();
    const [ra, rb] = await Promise.all([a, b]);

    expect(state.readCalls).toEqual(['ui://x/1.html']);
    expect(ra).toEqual(rb);
  });

  it('invalidates the cache on notifications/resources/list_changed', async () => {
    await connect([]);
    await mcpManager.readResource(SERVER, 'ui://x/1.html');

    const entry = state.notificationHandlers.find((h) => h.schema === ResourceListChangedNotificationSchema);
    expect(entry).toBeDefined();
    entry!.handler({ method: 'notifications/resources/list_changed' });

    await mcpManager.readResource(SERVER, 'ui://x/1.html');
    expect(state.readCalls).toHaveLength(2);
  });

  it('invalidates the cache when the server disconnects', async () => {
    await connect([]);
    await mcpManager.readResource(SERVER, 'ui://x/1.html');
    await mcpManager.disconnectServer(SERVER);

    await connect([]);
    await mcpManager.readResource(SERVER, 'ui://x/1.html');
    expect(state.readCalls).toHaveLength(2);
  });

  it('rejects an unknown server', async () => {
    await expect(mcpManager.readResource('not-connected', 'ui://x/1.html')).rejects.toThrow('not connected');
    expect(state.readCalls).toHaveLength(0);
  });

  it('rejects a non-ui:// uri', async () => {
    await connect([]);
    await expect(mcpManager.readResource(SERVER, 'file:///etc/passwd')).rejects.toThrow('ui://');
    expect(state.readCalls).toHaveLength(0);
  });

  it('rejects a resource larger than the 2 MB limit', async () => {
    await connect([]);
    const oversized = 'a'.repeat(MAX_APP_RESOURCE_BYTES + 1);
    state.readResource = (uri) =>
      Promise.resolve({ contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: oversized }] });

    await expect(mcpManager.readResource(SERVER, 'ui://x/big.html')).rejects.toThrow(/too large/i);
  });

  it('rejects a resource with no text content', async () => {
    await connect([]);
    state.readResource = (uri) =>
      Promise.resolve({ contents: [{ uri, mimeType: 'image/png', blob: 'AAAA' }] } satisfies FakeResourceContents);

    await expect(mcpManager.readResource(SERVER, 'ui://x/blob.html')).rejects.toThrow(/no text content/i);
  });

  it('does not cache a failed read', async () => {
    await connect([]);
    state.readResource = () => Promise.reject(new Error('boom'));
    await expect(mcpManager.readResource(SERVER, 'ui://x/1.html')).rejects.toThrow('boom');

    state.readResource = (uri) =>
      Promise.resolve({ contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: 'recovered' }] });
    const res = await mcpManager.readResource(SERVER, 'ui://x/1.html');
    expect(res.text).toBe('recovered');
    expect(state.readCalls).toHaveLength(2);
  });
});
