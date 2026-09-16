// (Split out of client.test.ts during the origin/dev merge: dev added its own
// `client.test.ts` for conversationId/_meta threading, this suite is the MCP
// Apps one. Same subject, incompatible module mocks — kept as two files.)
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
    callCalls: [] as Array<{ name: string; arguments: Record<string, unknown> }>,
    callResult: (params: { name: string }): unknown =>
      ({ content: [{ type: 'text', text: `called ${params.name}` }] }),
    listResourceCalls: [] as Array<{ cursor?: string } | undefined>,
    listResources: (): Promise<unknown> =>
      Promise.resolve({ resources: [{ uri: 'weather://today', name: 'today' }] }),
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
    async callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<unknown> {
      state.callCalls.push(params);
      return state.callResult(params);
    }
    async listResources(params?: { cursor?: string }): Promise<unknown> {
      state.listResourceCalls.push(params);
      return state.listResources();
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

import { mcpManager, resetRawAppResults } from './client';
import { publishPluginActivation } from '../plugin/activationPolicy';
import { MAX_APP_RESOURCE_BYTES, McpAppResourceError } from './appResources';

const SERVER = 'ui-server';

function tool(name: string, meta?: Record<string, unknown>): FakeTool {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    ...(meta ? { _meta: meta } : {}),
  };
}

/** Same as `tool()` but with a numeric parameter, to observe string → number coercion. */
function numericTool(name: string, meta?: Record<string, unknown>): FakeTool {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
    ...(meta ? { _meta: meta } : {}),
  };
}

async function connect(tools: FakeTool[], name = SERVER): Promise<void> {
  state.tools = tools;
  await mcpManager.connectServer({ name, command: 'echo', args: [] });
}

it('closes a pending handshake before disconnect resolves', async () => {
  let began!: () => void;
  let finish!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const spy = vi.spyOn(mcpMock.FakeClient.prototype, 'connect').mockImplementationOnce(async () => {
    began();
    await new Promise<void>(resolve => { finish = resolve; });
  });
  try {
    const connecting = connect([tool('pending-tool')]);
    await started;
    await mcpManager.disconnectServer(SERVER);
    expect(state.closed).toBe(1);
    finish();
    await expect(connecting).rejects.toThrow();
    expect(state.closed).toBe(1);
    expect(mcpManager.getServerTools(SERVER)).toEqual([]);
  } finally { spy.mockRestore(); }
});

it('does not delete a newer connection when an older close completes', async () => {
  await connect([tool('old-tool')]);
  let finish!: () => void;
  const spy = vi.spyOn(mcpMock.FakeClient.prototype, 'close').mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  try {
    const closing = mcpManager.disconnectServer(SERVER);
    await Promise.resolve();
    await connect([tool('new-tool')]);
    finish();
    await closing;
    expect(mcpManager.getServerTools(SERVER).map(t => t.name)).toEqual([`${SERVER}__new-tool`]);
    await mcpManager.disconnectServer(SERVER);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.instances[0]).not.toBe(spy.mock.instances[1]);
  } finally { spy.mockRestore(); }
});

it('does not publish an old MCP connection after its plugin is turned off and back on', async () => {
  const activation = { enabled: true, root: '/plugin', skillDirs: [], legacySkills: false, agentFiles: [], mcpServers: [SERVER] };
  publishPluginActivation({ 'demo@market': activation }, [SERVER], true);
  let finish!: () => void;
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const connectSpy = vi.spyOn(mcpMock.FakeClient.prototype, 'connect').mockImplementationOnce(async () => {
    began();
    await new Promise<void>(resolve => { finish = resolve; });
  });
  try {
    const connecting = connect([tool('old-tool')]);
    await started;
    publishPluginActivation({ 'demo@market': { ...activation, enabled: false } }, [SERVER], true);
    publishPluginActivation({ 'demo@market': activation }, [SERVER], true);
    finish();
    await expect(connecting).rejects.toThrow();
    expect(state.closed).toBe(1);
    expect(mcpManager.getServerTools(SERVER)).toEqual([]);
  } finally { connectSpy.mockRestore(); }
});

beforeEach(() => {
  publishPluginActivation({}, [], true);
  state.tools = [];
  state.readCalls = [];
  state.callCalls = [];
  state.notificationHandlers = [];
  state.listResourceCalls = [];
  state.closed = 0;
  state.callResult = (params: { name: string }) =>
    ({ content: [{ type: 'text', text: `called ${params.name}` }] });
  state.listResources = () =>
    Promise.resolve({ resources: [{ uri: 'weather://today', name: 'today' }] });
  resetRawAppResults();
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

describe('testConnection', () => {
  // The count in the connector UI is a decision aid: a server whose tools are
  // all interface-driven would read as "0 tools" — i.e. broken — if app-only
  // tools were simply left out, and as a bigger model surface than it has if
  // they were folded into `toolCount`. So they are reported separately.
  it('reports model-visible and app-only tools separately', async () => {
    state.tools = [
      tool('modelTool', { ui: { resourceUri: 'ui://x/1.html', visibility: ['model', 'app'] } }),
      tool('plain'),
      tool('appOnly', { ui: { resourceUri: 'ui://x/2.html', visibility: ['app'] } }),
    ];

    const result = await mcpManager.testConnection({ name: 'probe', command: 'echo', args: [] });

    expect(result).toMatchObject({ success: true, toolCount: 2, appToolCount: 1 });
  });

  it('reports zero app-only tools for a plain connector', async () => {
    state.tools = [tool('plain')];

    expect(await mcpManager.testConnection({ name: 'probe', command: 'echo', args: [] }))
      .toMatchObject({ success: true, toolCount: 1, appToolCount: 0 });
  });

  it('probes an active connection without closing it or creating another instance', async () => {
    state.tools = [tool('plain')];
    const config = { name: 'active-probe', command: 'echo', args: [] };
    await mcpManager.connectServer(config);
    const closedBefore = state.closed;
    const connect = vi.spyOn(mcpManager, 'connectServer');
    const disconnect = vi.spyOn(mcpManager, 'disconnectServer');
    expect(await mcpManager.testConnection(config)).toMatchObject({ success: true, toolCount: 1 });
    expect(connect).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    expect(state.closed).toBe(closedBefore);
    expect(mcpManager.getStatus().find(s => s.name === config.name)?.connected).toBe(true);
    connect.mockRestore();
    disconnect.mockRestore();
  });

  it('leaves no temp server behind', async () => {
    state.tools = [tool('plain')];
    await mcpManager.testConnection({ name: 'probe', command: 'echo', args: [] });
    expect(mcpManager.getStatus().map((s) => s.name)).not.toContain('probe');
  });
});

describe('callTool — app-only tools are fail-closed outside the app bridge', () => {
  const APP_ONLY = { ui: { resourceUri: 'ui://x/1.html', visibility: ['app'] } };
  const BOTH = { ui: { resourceUri: 'ui://x/2.html', visibility: ['model', 'app'] } };

  it('rejects an app-only tool on the model path without reaching the SDK', async () => {
    await connect([tool('appOnly', APP_ONLY)]);

    // The model can learn the name from the app's HTML / a README / a replayed
    // session; registry.ts dispatches any `server__tool` by name, so hiding the
    // tool is not enough — the call itself must fail before any RPC.
    const err = await mcpManager.callTool(SERVER, 'appOnly', { q: '1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpAppResourceError);
    expect((err as McpAppResourceError).code).toBe('app-only-tool');
    expect(state.callCalls).toHaveLength(0);
  });

  it('runs an app-only tool when the app bridge asks, with numeric coercion', async () => {
    await connect([numericTool('appOnly', APP_ONLY)]);

    const result = await mcpManager.callTool(SERVER, 'appOnly', { n: '42' }, { viaAppBridge: true });

    expect(result).toBe('called appOnly');
    expect(state.callCalls).toEqual([{ name: 'appOnly', arguments: { n: 42 } }]);
  });

  it('leaves a model+app tool callable on both paths', async () => {
    await connect([numericTool('both', BOTH)]);

    expect(await mcpManager.callTool(SERVER, 'both', { n: '7' })).toBe('called both');
    expect(await mcpManager.callTool(SERVER, 'both', { n: '8' }, { viaAppBridge: true })).toBe('called both');
    expect(state.callCalls).toEqual([
      { name: 'both', arguments: { n: 7 } },
      { name: 'both', arguments: { n: 8 } },
    ]);
  });
});

describe('refreshServerTools', () => {
  it('re-splits model / app-only tools and carries ui metadata over', async () => {
    await connect([
      tool('a', { ui: { resourceUri: 'ui://x/1.html', visibility: ['model', 'app'] } }),
      tool('b', {}),
    ]);
    expect(mcpManager.getAppTool(SERVER, 'a')).toBeUndefined();

    // 'a' flips to app-only, 'b' gains a model-visible interface.
    state.tools = [
      tool('a', { ui: { resourceUri: 'ui://x/1.html', visibility: ['app'] } }),
      tool('b', { ui: { resourceUri: 'ui://x/2.html', visibility: ['model'] } }),
    ];
    const count = await mcpManager.refreshServerTools(SERVER);

    expect(count).toBe(1);
    expect(mcpManager.getServerTools(SERVER).map((t) => t.name)).toEqual([`${SERVER}__b`]);
    expect(mcpManager.getServerTools(SERVER)[0]?.ui).toEqual({
      resourceUri: 'ui://x/2.html',
      visibility: ['model'],
    });
    expect(mcpManager.getAppTool(SERVER, 'a')?.ui).toEqual({
      resourceUri: 'ui://x/1.html',
      visibility: ['app'],
    });
    expect(mcpManager.getAppTool(SERVER, 'b')).toBeUndefined();

    // The refreshed split is enforced by callTool too.
    const err = await mcpManager.callTool(SERVER, 'a', {}).catch((e: unknown) => e);
    expect((err as McpAppResourceError).code).toBe('app-only-tool');
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

  it('picks the content whose uri matches, not merely the first text content', async () => {
    await connect([]);
    state.readResource = () =>
      Promise.resolve({
        contents: [
          { uri: 'ui://x/sibling.html', mimeType: 'text/html;profile=mcp-app', text: 'sibling' },
          { uri: 'ui://x/1.html', mimeType: 'text/html;profile=mcp-app', text: 'wanted' },
        ],
      });

    const res = await mcpManager.readResource(SERVER, 'ui://x/1.html');
    expect(res.text).toBe('wanted');
    // …and the cache keeps the matched one.
    expect((await mcpManager.readResource(SERVER, 'ui://x/1.html')).text).toBe('wanted');
    expect(state.readCalls).toEqual(['ui://x/1.html']);
  });

  it('falls back to the first text content when no uri matches', async () => {
    await connect([]);
    state.readResource = () =>
      Promise.resolve({
        contents: [
          { mimeType: 'image/png', blob: 'AAAA' },
          { mimeType: 'text/html;profile=mcp-app', text: 'only-text' },
        ],
      });

    expect((await mcpManager.readResource(SERVER, 'ui://x/1.html')).text).toBe('only-text');
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

describe('raw app-result LRU (controller ruling)', () => {
  const UI_META = { ui: { resourceUri: 'ui://board/main.html', visibility: ['model', 'app'] } };

  it('stashes the server\'s own result for a tool that has an interface', async () => {
    await connect([tool('board', UI_META)]);
    state.callResult = () => ({
      content: [{ type: 'text', text: 'rows' }],
      structuredContent: { rows: [1, 2] },
      _meta: { trace: 'abc' },
    });

    await mcpManager.callTool(SERVER, 'board', { q: 'x' });
    const raw = mcpManager.takeRawAppResult(SERVER, 'board', { q: 'x' });
    // Abu's own return value dropped structuredContent/_meta; the stash keeps them.
    expect(raw).toMatchObject({ structuredContent: { rows: [1, 2] }, _meta: { trace: 'abc' } });
  });

  it('hands a stashed result over exactly once', async () => {
    await connect([tool('board', UI_META)]);
    await mcpManager.callTool(SERVER, 'board', { q: 'x' });
    expect(mcpManager.takeRawAppResult(SERVER, 'board', { q: 'x' })).toBeDefined();
    expect(mcpManager.takeRawAppResult(SERVER, 'board', { q: 'x' })).toBeUndefined();
  });

  it('keys on the arguments regardless of key order', async () => {
    await connect([tool('board', UI_META)]);
    await mcpManager.callTool(SERVER, 'board', { q: 'x', z: 1 });
    expect(mcpManager.takeRawAppResult(SERVER, 'board', { z: 1, q: 'x' })).toBeDefined();
  });

  it('misses on different arguments, a different tool or a different server', async () => {
    await connect([tool('board', UI_META)]);
    await mcpManager.callTool(SERVER, 'board', { q: 'x' });
    expect(mcpManager.takeRawAppResult(SERVER, 'board', { q: 'other' })).toBeUndefined();
    expect(mcpManager.takeRawAppResult(SERVER, 'other', { q: 'x' })).toBeUndefined();
    expect(mcpManager.takeRawAppResult('elsewhere', 'board', { q: 'x' })).toBeUndefined();
  });

  it('does not stash for a tool without an interface', async () => {
    await connect([tool('plain')]);
    await mcpManager.callTool(SERVER, 'plain', { q: 'x' });
    expect(mcpManager.takeRawAppResult(SERVER, 'plain', { q: 'x' })).toBeUndefined();
  });

  it('skips a result larger than the per-entry cap', async () => {
    await connect([tool('board', UI_META)]);
    state.callResult = () => ({ content: [{ type: 'text', text: 'x'.repeat(300 * 1024) }] });
    await mcpManager.callTool(SERVER, 'board', { q: 'big' });
    expect(mcpManager.takeRawAppResult(SERVER, 'board', { q: 'big' })).toBeUndefined();
  });

  it('evicts the oldest entry past 32', async () => {
    await connect([tool('board', UI_META)]);
    for (let i = 0; i < 33; i++) {
      await mcpManager.callTool(SERVER, 'board', { q: `arg-${i}` });
    }
    expect(mcpManager.takeRawAppResult(SERVER, 'board', { q: 'arg-0' })).toBeUndefined();
    expect(mcpManager.takeRawAppResult(SERVER, 'board', { q: 'arg-32' })).toBeDefined();
  });
});

describe('read-only server resources for the app bridge', () => {
  it('reads a non-ui:// resource without touching the ui:// cache', async () => {
    await connect([tool('board')]);
    state.readResource = (uri: string) =>
      Promise.resolve({ contents: [{ uri, mimeType: 'application/json', text: '{"a":1}' }] });

    const first = await mcpManager.readServerResource(SERVER, 'weather://today');
    const second = await mcpManager.readServerResource(SERVER, 'weather://today');
    expect(first.contents[0]).toMatchObject({ uri: 'weather://today', text: '{"a":1}' });
    // Uncached on purpose — server data can change between reads.
    expect(state.readCalls).toEqual(['weather://today', 'weather://today']);
    expect(second.contents[0]).toMatchObject({ text: '{"a":1}' });
  });

  it('refuses a payload over the 2 MiB cap', async () => {
    await connect([tool('board')]);
    const big = 'x'.repeat(MAX_APP_RESOURCE_BYTES + 1);
    state.readResource = (uri: string) => Promise.resolve({ contents: [{ uri, text: big }] });

    await expect(mcpManager.readServerResource(SERVER, 'weather://big'))
      .rejects.toMatchObject({ code: 'resource-too-large' });
  });

  it('refuses a server that is not connected', async () => {
    await expect(mcpManager.readServerResource('nope', 'weather://today'))
      .rejects.toBeInstanceOf(McpAppResourceError);
    await expect(mcpManager.listServerResources('nope'))
      .rejects.toBeInstanceOf(McpAppResourceError);
  });

  it('lists that server\'s resources and forwards the cursor', async () => {
    await connect([tool('board')]);
    state.listResources = () => Promise.resolve({
      resources: [{ uri: 'weather://today', name: 'today' }, { name: 'no uri' }],
      nextCursor: 'c2',
    });

    const listed = await mcpManager.listServerResources(SERVER, 'c1');
    expect(state.listResourceCalls).toEqual([{ cursor: 'c1' }]);
    // Entries without a uri are unusable — dropped rather than passed on.
    expect(listed.resources).toEqual([{ uri: 'weather://today', name: 'today' }]);
    expect(listed.nextCursor).toBe('c2');
  });
});


it.each(['readResource', 'readServerResource', 'listServerResources'] as const)('holds plugin admission until %s settles', async method => {
  const { acquirePluginChange } = await import('../plugin/runtimeLease');
  publishPluginActivation({ 'held@market': { enabled: true, root: '/pkg', skillDirs: [], legacySkills: false, agentFiles: [], mcpServers: [SERVER] } }, [SERVER], true);
  await connect([]);
  let finish!: (value: unknown) => void;
  const pending = new Promise<unknown>(resolve => { finish = resolve; });
  state.readResource = () => pending;
  state.listResources = () => pending;
  const reading = method === 'listServerResources' ? mcpManager.listServerResources(SERVER) : mcpManager[method](SERVER, 'ui://held');
  expect(() => acquirePluginChange('held@market')).toThrow();
  finish({ contents: [{ uri: 'ui://held', text: 'hello' }], resources: [] });
  await reading;
  const release = acquirePluginChange('held@market');
  release();
});
