import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition } from '@/types';
import {
  AppBridgeRpcError,
  MAX_APP_MESSAGE_BYTES,
  MAX_APP_MODEL_CONTEXT_BYTES,
  MAX_APP_TOOL_CALLS_PER_MINUTE,
  createAppBridgeHandlers,
  createRateLimiter,
  textFromContentBlocks,
  truncateToBytes,
  validateToolArguments,
  type AppBridgeHandlerDeps,
  type McpAppAuditEntry,
} from './appBridgeHandlers';

function toolDef(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'search',
    description: 'search things',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'q' },
        limit: { type: 'number', description: 'n' },
      },
      required: ['query'],
    },
    execute: async () => 'never called through this path',
    ...overrides,
  };
}

const OK: CallToolResult = { content: [{ type: 'text', text: 'two rows' }] };

interface Harness {
  handlers: ReturnType<typeof createAppBridgeHandlers>;
  deps: { [K in keyof AppBridgeHandlerDeps]: AppBridgeHandlerDeps[K] };
  audit: McpAppAuditEntry[];
  clock: { value: number };
  spies: {
    checkApproval: ReturnType<typeof vi.fn>;
    callTool: ReturnType<typeof vi.fn>;
    openLink: ReturnType<typeof vi.fn>;
    appendComposerDraft: ReturnType<typeof vi.fn>;
    setModelContext: ReturnType<typeof vi.fn>;
    setDisplayMode: ReturnType<typeof vi.fn>;
    onRateLimited: ReturnType<typeof vi.fn>;
    readAppResource: ReturnType<typeof vi.fn>;
    readServerResource: ReturnType<typeof vi.fn>;
    listResources: ReturnType<typeof vi.fn>;
  };
}

function harness(overrides: Partial<AppBridgeHandlerDeps> = {}): Harness {
  const audit: McpAppAuditEntry[] = [];
  const clock = { value: 1_000_000 };
  const spies = {
    checkApproval: vi.fn(async () => ({ decision: 'allow' as const })),
    callTool: vi.fn(async () => OK),
    openLink: vi.fn(),
    appendComposerDraft: vi.fn(),
    setModelContext: vi.fn(),
    setDisplayMode: vi.fn(),
    onRateLimited: vi.fn(),
    readAppResource: vi.fn(async () => ({ mimeType: 'text/html;profile=mcp-app', text: '<p>x</p>' })),
    readServerResource: vi.fn(async () => ({ contents: [{ uri: 'file://a', text: 'a' }] })),
    listResources: vi.fn(async () => ({ resources: [{ uri: 'ui://a/b', name: 'b' }] })),
  };
  const deps: AppBridgeHandlerDeps = {
    server: 'weather',
    findTool: (name: string) => (name === 'search' ? toolDef() : undefined),
    onAudit: (entry) => audit.push(entry),
    now: () => clock.value,
    nextAuditId: (() => { let n = 0; return () => `a${++n}`; })(),
    ...spies,
    ...overrides,
  };
  return { handlers: createAppBridgeHandlers(deps), deps, audit, clock, spies };
}

async function rpcError(fn: () => Promise<unknown>): Promise<AppBridgeRpcError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppBridgeRpcError);
    return error as AppBridgeRpcError;
  }
  throw new Error('expected the handler to reject');
}

describe('validateToolArguments', () => {
  it('passes a well-formed payload', () => {
    expect(validateToolArguments(toolDef().inputSchema, { query: 'abu', limit: 3 })).toBeUndefined();
  });

  it('names the missing required key', () => {
    expect(validateToolArguments(toolDef().inputSchema, { limit: 3 })).toContain('query');
  });

  it('rejects a declared-type mismatch', () => {
    expect(validateToolArguments(toolDef().inputSchema, { query: 42 })).toContain('string');
  });

  it('accepts a numeric string where the model path would coerce it', () => {
    expect(validateToolArguments(toolDef().inputSchema, { query: 'a', limit: '3' })).toBeUndefined();
  });

  it('ignores undeclared keys and undeclared types', () => {
    expect(validateToolArguments(toolDef().inputSchema, { query: 'a', extra: { deep: 1 } })).toBeUndefined();
  });
});

describe('truncateToBytes', () => {
  it('leaves a short string alone', () => {
    expect(truncateToBytes('hello', 10)).toBe('hello');
  });

  it('never splits a multi-byte code point', () => {
    // '界' is 3 bytes; a 4-byte budget fits exactly one.
    expect(truncateToBytes('界面', 4)).toBe('界');
  });
});

describe('textFromContentBlocks', () => {
  it('joins text blocks and drops everything else', () => {
    expect(textFromContentBlocks([
      { type: 'text', text: 'a' },
      { type: 'image', data: 'zzz' },
      { type: 'text', text: 'b' },
    ])).toBe('a\nb');
  });

  it('is empty for a non-array', () => {
    expect(textFromContentBlocks(undefined)).toBe('');
  });
});

describe('createRateLimiter', () => {
  it('lets the window roll forward', () => {
    let now = 0;
    const limiter = createRateLimiter(2, 1000, () => now);
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(false);
    now = 1000;
    expect(limiter.tryConsume()).toBe(true);
  });
});

describe('oncalltool', () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  it('runs a same-server tool through the shared permission gate', async () => {
    const result = await h.handlers.oncalltool({ name: 'search', arguments: { query: 'abu' } });
    expect(result).toEqual(OK);
    // The gate sees the NAMESPACED name — the same string a model-initiated
    // call carries, so every classifier keyed on it agrees.
    expect(h.spies.checkApproval).toHaveBeenCalledWith('weather__search', { query: 'abu' });
    expect(h.spies.callTool).toHaveBeenCalledWith('search', { query: 'abu' });
  });

  it('refuses a tool that does not exist on this server, without asking the gate', async () => {
    const error = await rpcError(() => h.handlers.oncalltool({ name: 'other__thing', arguments: {} }));
    expect(error.code).toBe(-32602);
    expect(error.message).toContain('weather');
    expect(h.spies.checkApproval).not.toHaveBeenCalled();
    expect(h.spies.callTool).not.toHaveBeenCalled();
  });

  it('refuses arguments the schema rejects, before the gate and before execution', async () => {
    const error = await rpcError(() => h.handlers.oncalltool({ name: 'search', arguments: { limit: 2 } }));
    expect(error.code).toBe(-32602);
    expect(h.spies.checkApproval).not.toHaveBeenCalled();
    expect(h.spies.callTool).not.toHaveBeenCalled();
  });

  it('turns a denial into a JSON-RPC error and never executes', async () => {
    h = harness({ checkApproval: vi.fn(async () => ({ decision: 'deny' as const, reason: 'Error: user cancelled' })) });
    const error = await rpcError(() => h.handlers.oncalltool({ name: 'search', arguments: { query: 'a' } }));
    expect(error.code).toBe(-32000);
    expect(error.message).toContain('user cancelled');
    expect(h.spies.callTool).not.toHaveBeenCalled();
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({ tool: 'search', isError: true });
  });

  it('records an audit row for every executed call', async () => {
    await h.handlers.oncalltool({ name: 'search', arguments: { query: 'abu' } });
    expect(h.audit).toEqual([
      { id: 'a1', tool: 'search', args: { query: 'abu' }, summary: 'two rows', isError: false },
    ]);
  });

  it('records a failing call as an errored audit row', async () => {
    h = harness({ callTool: vi.fn(async () => { throw new Error('server exploded'); }) });
    const error = await rpcError(() => h.handlers.oncalltool({ name: 'search', arguments: { query: 'a' } }));
    expect(error.message).toContain('server exploded');
    expect(h.audit[0]).toMatchObject({ isError: true, summary: 'server exploded' });
  });

  it('stops at the per-minute budget and reports it once', async () => {
    for (let i = 0; i < MAX_APP_TOOL_CALLS_PER_MINUTE; i++) {
      await h.handlers.oncalltool({ name: 'search', arguments: { query: `q${i}` } });
    }
    const error = await rpcError(() => h.handlers.oncalltool({ name: 'search', arguments: { query: 'over' } }));
    expect(error.code).toBe(-32001);
    expect(h.spies.onRateLimited).toHaveBeenCalledTimes(1);
    expect(h.spies.callTool).toHaveBeenCalledTimes(MAX_APP_TOOL_CALLS_PER_MINUTE);

    h.clock.value += 60_000;
    await expect(h.handlers.oncalltool({ name: 'search', arguments: { query: 'later' } })).resolves.toEqual(OK);
  });
});

describe('resources', () => {
  it('serves a ui:// uri from the cached app-resource reader', async () => {
    const h = harness();
    const result = await h.handlers.onreadresource({ uri: 'ui://weather/panel' });
    expect(result.contents[0]).toMatchObject({ uri: 'ui://weather/panel', text: '<p>x</p>' });
    expect(h.spies.readServerResource).not.toHaveBeenCalled();
  });

  it('sends every other uri down the read-only, uncached server path', async () => {
    const h = harness();
    await h.handlers.onreadresource({ uri: 'weather://forecast/today' });
    expect(h.spies.readServerResource).toHaveBeenCalledWith('weather://forecast/today');
    expect(h.spies.readAppResource).not.toHaveBeenCalled();
  });

  it('propagates the reader cap as a JSON-RPC error', async () => {
    const h = harness({
      readServerResource: vi.fn(async () => { throw new Error('Resource exceeds 2 MiB'); }),
    });
    await expect(h.handlers.onreadresource({ uri: 'weather://big' })).rejects.toThrow('2 MiB');
  });

  it('lists this server’s resources', async () => {
    const h = harness();
    const listed = await h.handlers.onlistresources({ cursor: 'c1' });
    expect(h.spies.listResources).toHaveBeenCalledWith('c1');
    expect(listed.resources).toHaveLength(1);
  });
});

describe('ui/open-link', () => {
  it('opens http(s) through the shared widget link path', async () => {
    const h = harness();
    await h.handlers.onopenlink({ url: 'https://example.com/a?b=1' });
    expect(h.spies.openLink).toHaveBeenCalledWith('https://example.com/a?b=1');
  });

  it.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'abu://internal',
  ])('refuses %s', async (url) => {
    const h = harness();
    const error = await rpcError(() => h.handlers.onopenlink({ url }));
    expect(error.code).toBe(-32000);
    expect(h.spies.openLink).not.toHaveBeenCalled();
  });

  it('refuses a string that is not a URL at all', async () => {
    const h = harness();
    const error = await rpcError(() => h.handlers.onopenlink({ url: 'not a url' }));
    expect(error.code).toBe(-32602);
    expect(h.spies.openLink).not.toHaveBeenCalled();
  });
});

describe('ui/message', () => {
  it('writes the text into the composer draft', async () => {
    const h = harness();
    await h.handlers.onmessage({ role: 'user', content: [{ type: 'text', text: 'book it' }] });
    expect(h.spies.appendComposerDraft).toHaveBeenCalledWith('book it');
  });

  it('caps a flood at 4 KB', async () => {
    const h = harness();
    await h.handlers.onmessage({ role: 'user', content: [{ type: 'text', text: 'x'.repeat(9000) }] });
    const written = h.spies.appendComposerDraft.mock.calls[0][0] as string;
    expect(written.length).toBe(MAX_APP_MESSAGE_BYTES);
  });

  it('refuses an empty message instead of clearing the draft', async () => {
    const h = harness();
    await rpcError(() => h.handlers.onmessage({ role: 'user', content: [{ type: 'image', data: 'z' }] }));
    expect(h.spies.appendComposerDraft).not.toHaveBeenCalled();
  });
});

describe('ui/update-model-context', () => {
  it('stores the text', async () => {
    const h = harness();
    await h.handlers.onupdatemodelcontext({ content: [{ type: 'text', text: 'selected row 4' }] });
    expect(h.spies.setModelContext).toHaveBeenCalledWith('selected row 4');
  });

  it('overwrites rather than appending', async () => {
    const h = harness();
    await h.handlers.onupdatemodelcontext({ content: [{ type: 'text', text: 'first' }] });
    await h.handlers.onupdatemodelcontext({ content: [{ type: 'text', text: 'second' }] });
    expect(h.spies.setModelContext.mock.calls.map((c) => c[0])).toEqual(['first', 'second']);
  });

  it('caps at 8 KB', async () => {
    const h = harness();
    await h.handlers.onupdatemodelcontext({ content: [{ type: 'text', text: 'y'.repeat(20000) }] });
    expect((h.spies.setModelContext.mock.calls[0][0] as string).length).toBe(MAX_APP_MODEL_CONTEXT_BYTES);
  });
});

describe('ui/request-display-mode', () => {
  it.each(['inline', 'fullscreen'] as const)('accepts %s', async (mode) => {
    const h = harness();
    await expect(h.handlers.onrequestdisplaymode({ mode })).resolves.toEqual({ mode });
    expect(h.spies.setDisplayMode).toHaveBeenCalledWith(mode);
  });

  it('refuses pip', async () => {
    const h = harness();
    const error = await rpcError(() => h.handlers.onrequestdisplaymode({ mode: 'pip' }));
    expect(error.code).toBe(-32602);
    expect(h.spies.setDisplayMode).not.toHaveBeenCalled();
  });
});
