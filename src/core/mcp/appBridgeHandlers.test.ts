import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition } from '@/types';
import {
  AppBridgeRpcError,
  MAX_APP_MESSAGE_BYTES,
  APP_TOOL_FAILURE_MESSAGE,
  MAX_APP_LINK_URL_CHARS,
  MAX_APP_MODEL_CONTEXT_BYTES,
  MAX_APP_MODEL_CONTEXT_UPDATES_PER_MINUTE,
  MAX_APP_RESOURCE_READS_PER_MINUTE,
  MAX_APP_TOOL_CALLS_PER_MINUTE,
  MAX_CONCURRENT_APP_RESOURCE_READS,
  MODEL_CONTEXT_PERSIST_INTERVAL_MS,
  FULLSCREEN_EXIT_COOLDOWN_MS,
  FULLSCREEN_GESTURE_REQUIRED_MESSAGE,
  FULLSCREEN_GESTURE_WINDOW_MS,
  TOO_MANY_RESOURCE_READS_MESSAGE,
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
  scheduled: Array<{ fn: () => void; ms: number; cancelled: boolean }>;
  runScheduled: () => void;
  spies: {
    checkApproval: ReturnType<typeof vi.fn>;
    callTool: ReturnType<typeof vi.fn>;
    requestOpenLink: ReturnType<typeof vi.fn>;
    appendComposerDraft: ReturnType<typeof vi.fn>;
    setModelContext: ReturnType<typeof vi.fn>;
    persistModelContext: ReturnType<typeof vi.fn>;
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
    requestOpenLink: vi.fn(async () => true),
    appendComposerDraft: vi.fn(),
    setModelContext: vi.fn(),
    persistModelContext: vi.fn(),
    setDisplayMode: vi.fn(),
    onRateLimited: vi.fn(),
    readAppResource: vi.fn(async () => ({ mimeType: 'text/html;profile=mcp-app', text: '<p>x</p>' })),
    readServerResource: vi.fn(async () => ({ contents: [{ uri: 'file://a', text: 'a' }] })),
    listResources: vi.fn(async () => ({ resources: [{ uri: 'ui://a/b', name: 'b' }] })),
  };
  // Hand-driven timer: `runScheduled()` is the fake clock's tick. Real timers
  // are banned in this repo's tests and a scheduler seam is more explicit than
  // `vi.useFakeTimers()` for a single trailing-edge window.
  const scheduled: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const deps: AppBridgeHandlerDeps = {
    server: 'weather',
    findTool: (name: string) => (name === 'search' ? toolDef() : undefined),
    onAudit: (entry) => audit.push(entry),
    now: () => clock.value,
    nextAuditId: (() => { let n = 0; return () => `a${++n}`; })(),
    schedule: (fn, ms) => {
      const entry = { fn, ms, cancelled: false };
      scheduled.push(entry);
      return () => { entry.cancelled = true; };
    },
    ...spies,
    ...overrides,
  };
  const runScheduled = () => {
    const due = scheduled.splice(0, scheduled.length);
    for (const entry of due) if (!entry.cancelled) entry.fn();
  };
  return { handlers: createAppBridgeHandlers(deps), deps, audit, clock, spies, scheduled, runScheduled };
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
      { id: 'a1', kind: 'tool-call', tool: 'search', args: { query: 'abu' }, summary: 'two rows', isError: false },
    ]);
  });

  it('records a failing call as an errored audit row', async () => {
    h = harness({ callTool: vi.fn(async () => { throw new Error('server exploded'); }) });
    const error = await rpcError(() => h.handlers.oncalltool({ name: 'search', arguments: { query: 'a' } }));
    // The app is told nothing but "it failed"; the user keeps the real text.
    expect(error.message).toBe(APP_TOOL_FAILURE_MESSAGE);
    expect(error.message).not.toContain('server exploded');
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

  it('audits every read and every list, not just the refused ones', async () => {
    const h = harness();
    await h.handlers.onreadresource({ uri: 'weather://forecast/today' });
    await h.handlers.onlistresources({});
    expect(h.audit).toMatchObject([
      { kind: 'resource', tool: 'resources/read', outcome: 'ok', isError: false, args: { uri: 'weather://forecast/today' } },
      { kind: 'resource', tool: 'resources/list', outcome: 'ok', isError: false, summary: 'ui://a/b' },
    ]);
  });

  it('audits a failed read as an errored row and still propagates', async () => {
    const h = harness({
      readServerResource: vi.fn(async () => { throw new Error('Resource exceeds 2 MiB'); }),
    });
    await expect(h.handlers.onreadresource({ uri: 'weather://big' })).rejects.toThrow('2 MiB');
    expect(h.audit).toMatchObject([
      { kind: 'resource', tool: 'resources/read', outcome: 'error', isError: true, summary: 'Resource exceeds 2 MiB' },
    ]);
  });

  it(`runs ${MAX_CONCURRENT_APP_RESOURCE_READS} reads at once and refuses the next until one lands`, async () => {
    const pending: Array<(value: { contents: [] }) => void> = [];
    const read = vi.fn(() => new Promise<never>((resolve) => {
      pending.push(resolve as unknown as (value: { contents: [] }) => void);
    }));
    const h = harness({ readServerResource: read });
    const inFlight = Array.from(
      { length: MAX_CONCURRENT_APP_RESOURCE_READS },
      (_, i) => h.handlers.onreadresource({ uri: `weather://r${i}` }),
    );
    await Promise.resolve();
    expect(pending).toHaveLength(MAX_CONCURRENT_APP_RESOURCE_READS);

    const error = await rpcError(() => h.handlers.onreadresource({ uri: 'weather://over' }));
    expect(error.code).toBe(-32000);
    expect(error.message).toBe(TOO_MANY_RESOURCE_READS_MESSAGE);
    expect(h.audit[h.audit.length - 1]).toMatchObject({ kind: 'resource', outcome: 'denied', isError: true });
    // Only the four that fit ever reached the connector.
    expect(read).toHaveBeenCalledTimes(MAX_CONCURRENT_APP_RESOURCE_READS);

    pending.splice(0).forEach((resolve) => resolve({ contents: [] }));
    await Promise.all(inFlight);

    const after = h.handlers.onreadresource({ uri: 'weather://after' });
    await Promise.resolve();
    pending.splice(0).forEach((resolve) => resolve({ contents: [] }));
    await expect(after).resolves.toMatchObject({ contents: [] });
  });

  it(`refuses read number ${MAX_APP_RESOURCE_READS_PER_MINUTE + 1} in a minute, then accepts again`, async () => {
    const h = harness();
    for (let i = 0; i < MAX_APP_RESOURCE_READS_PER_MINUTE; i++) {
      await h.handlers.onreadresource({ uri: `weather://r${i}` });
    }
    const error = await rpcError(() => h.handlers.onreadresource({ uri: 'weather://over' }));
    expect(error.code).toBe(-32001);
    expect(h.spies.onRateLimited).toHaveBeenCalledTimes(1);
    expect(h.audit[h.audit.length - 1]).toMatchObject({ kind: 'resource', outcome: 'rate-limited', isError: true });

    h.clock.value += 60_000;
    await expect(h.handlers.onreadresource({ uri: 'weather://later' })).resolves.toBeDefined();
  });

  it('spends its own budget, not the tools/call one', async () => {
    const h = harness();
    for (let i = 0; i < MAX_APP_RESOURCE_READS_PER_MINUTE; i++) {
      await h.handlers.onreadresource({ uri: `weather://r${i}` });
    }
    await expect(h.handlers.oncalltool({ name: 'search', arguments: { query: 'q' } })).resolves.toEqual(OK);
  });
});

describe('ui/open-link', () => {
  it('opens http(s) through the shared widget link path', async () => {
    const h = harness();
    await h.handlers.onopenlink({ url: 'https://example.com/a?b=1' });
    expect(h.spies.requestOpenLink).toHaveBeenCalledWith('https://example.com/a?b=1');
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
    expect(h.spies.requestOpenLink).not.toHaveBeenCalled();
  });

  it('refuses a string that is not a URL at all', async () => {
    const h = harness();
    const error = await rpcError(() => h.handlers.onopenlink({ url: 'not a url' }));
    expect(error.code).toBe(-32602);
    expect(h.spies.requestOpenLink).not.toHaveBeenCalled();
  });

  it('leaves an "opened" audit row when the user agrees', async () => {
    const h = harness();
    await h.handlers.onopenlink({ url: 'https://example.com/a?b=1' });
    expect(h.audit).toEqual([{
      id: 'a1',
      kind: 'open-link',
      tool: 'ui/open-link',
      args: { url: 'https://example.com/a?b=1' },
      summary: 'https://example.com/a?b=1',
      isError: false,
      outcome: 'opened',
    }]);
  });

  it('turns a declined prompt into -32000 "user declined" plus an audit row', async () => {
    const h = harness({ requestOpenLink: vi.fn(async () => false) });
    const error = await rpcError(() => h.handlers.onopenlink({ url: 'https://example.com' }));
    expect(error.code).toBe(-32000);
    expect(error.message).toBe('user declined');
    expect(h.audit[0]).toMatchObject({ kind: 'open-link', outcome: 'declined', isError: true });
  });

  it('audits a rejected scheme instead of failing silently', async () => {
    const h = harness();
    await rpcError(() => h.handlers.onopenlink({ url: 'file:///etc/passwd' }));
    expect(h.audit[0]).toMatchObject({ kind: 'open-link', outcome: 'rejected-scheme', isError: true });
  });

  it('refuses a URL longer than the cap, before ever prompting', async () => {
    const h = harness();
    const url = `https://example.com/?q=${'x'.repeat(MAX_APP_LINK_URL_CHARS)}`;
    const error = await rpcError(() => h.handlers.onopenlink({ url }));
    expect(error.code).toBe(-32602);
    expect(h.spies.requestOpenLink).not.toHaveBeenCalled();
    expect(h.audit[0]).toMatchObject({ outcome: 'too-long', isError: true });
  });

  it('shares the per-minute budget with tools/call', async () => {
    const h = harness();
    for (let i = 0; i < MAX_APP_TOOL_CALLS_PER_MINUTE; i++) {
      await h.handlers.oncalltool({ name: 'search', arguments: { query: `q${i}` } });
    }
    const error = await rpcError(() => h.handlers.onopenlink({ url: 'https://example.com' }));
    expect(error.code).toBe(-32001);
    expect(h.spies.requestOpenLink).not.toHaveBeenCalled();
    expect(h.spies.onRateLimited).toHaveBeenCalled();
    expect(h.audit.at(-1)).toMatchObject({ kind: 'open-link', outcome: 'rate-limited' });
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

  it('coalesces 50 rapid updates into ONE persisted write, last value winning', async () => {
    const h = harness();
    for (let i = 0; i < 50; i++) {
      // Spaced past the per-minute acceptance cap (a different limit, tested
      // below) so this case measures coalescing alone. The persistence timer is
      // hand-driven, so none of these 50 ever flushes on its own.
      h.clock.value += 4_000;
      await h.handlers.onupdatemodelcontext({ content: [{ type: 'text', text: `v${i}` }] });
    }
    // Live value tracked every call; storage untouched until the window closes.
    expect(h.spies.setModelContext).toHaveBeenCalledTimes(50);
    expect(h.spies.persistModelContext).not.toHaveBeenCalled();
    expect(h.scheduled).toHaveLength(1);
    expect(h.scheduled[0].ms).toBe(MODEL_CONTEXT_PERSIST_INTERVAL_MS);

    h.runScheduled();
    expect(h.spies.persistModelContext).toHaveBeenCalledTimes(1);
    expect(h.spies.persistModelContext).toHaveBeenCalledWith('v49');
  });

  it('opens a new window after the previous one closed (one write per second)', async () => {
    const h = harness();
    await h.handlers.onupdatemodelcontext({ content: [{ type: 'text', text: 'a' }] });
    h.runScheduled();
    await h.handlers.onupdatemodelcontext({ content: [{ type: 'text', text: 'b' }] });
    h.runScheduled();
    expect(h.spies.persistModelContext.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
  });

  it('refuses the 21st update in a minute, then accepts again after the window rolls', async () => {
    const h = harness();
    for (let i = 0; i < MAX_APP_MODEL_CONTEXT_UPDATES_PER_MINUTE; i++) {
      await h.handlers.onupdatemodelcontext({ content: [{ type: 'text', text: `v${i}` }] });
    }
    const error = await rpcError(
      () => h.handlers.onupdatemodelcontext({ content: [{ type: 'text', text: 'over' }] }),
    );
    expect(error.code).toBe(-32001);
    expect(h.spies.setModelContext).toHaveBeenCalledTimes(MAX_APP_MODEL_CONTEXT_UPDATES_PER_MINUTE);

    h.clock.value += 60_001;
    await h.handlers.onupdatemodelcontext({ content: [{ type: 'text', text: 'later' }] });
    expect(h.spies.setModelContext).toHaveBeenLastCalledWith('later');
  });

  it('flushes the last pending write on dispose instead of dropping it', async () => {
    const h = harness();
    await h.handlers.onupdatemodelcontext({ content: [{ type: 'text', text: 'final' }] });
    h.handlers.dispose();
    expect(h.spies.persistModelContext).toHaveBeenCalledWith('final');
    // The cancelled timer must not write a second time.
    h.runScheduled();
    expect(h.spies.persistModelContext).toHaveBeenCalledTimes(1);
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

  it('honours the FIRST gesture-less fullscreen request once, then asks for a gesture', async () => {
    const h = harness();
    await expect(h.handlers.onrequestdisplaymode({ mode: 'fullscreen' })).resolves.toEqual({ mode: 'fullscreen' });
    const error = await rpcError(() => h.handlers.onrequestdisplaymode({ mode: 'fullscreen' }));
    expect(error.code).toBe(-32000);
    expect(error.message).toBe(FULLSCREEN_GESTURE_REQUIRED_MESSAGE);
    expect(h.spies.setDisplayMode).toHaveBeenCalledTimes(1);
  });

  it('allows fullscreen while a host gesture is fresh, and refuses once it is stale', async () => {
    const state: { gesture?: number } = {};
    const h = harness({ lastUserGestureAt: () => state.gesture });
    // Burn the one-shot grace so the gesture is doing the work.
    await h.handlers.onrequestdisplaymode({ mode: 'fullscreen' });

    state.gesture = h.clock.value - 500;
    await expect(h.handlers.onrequestdisplaymode({ mode: 'fullscreen' })).resolves.toEqual({ mode: 'fullscreen' });

    state.gesture = h.clock.value - (FULLSCREEN_GESTURE_WINDOW_MS + 1);
    const error = await rpcError(() => h.handlers.onrequestdisplaymode({ mode: 'fullscreen' }));
    expect(error.message).toBe(FULLSCREEN_GESTURE_REQUIRED_MESSAGE);
    expect(h.spies.setDisplayMode).toHaveBeenCalledTimes(2);
  });

  it('will not be dragged back in right after a user exit — the closing click is not consent', async () => {
    const state: { exit?: number; gesture?: number } = {};
    const h = harness({ lastUserExitAt: () => state.exit, lastUserGestureAt: () => state.gesture });
    await h.handlers.onrequestdisplaymode({ mode: 'fullscreen' });

    // The user closes it; that click IS a host gesture, and must not re-open it.
    state.exit = h.clock.value;
    state.gesture = h.clock.value;
    const denied = await rpcError(() => h.handlers.onrequestdisplaymode({ mode: 'fullscreen' }));
    expect(denied.code).toBe(-32000);
    expect(denied.message).toBe(FULLSCREEN_GESTURE_REQUIRED_MESSAGE);

    // Still refused one millisecond before the cool-down is up.
    h.clock.value += FULLSCREEN_EXIT_COOLDOWN_MS - 1;
    await rpcError(() => h.handlers.onrequestdisplaymode({ mode: 'fullscreen' }));

    // Past the cool-down the one-shot grace is gone too: a FRESH gesture or nothing.
    h.clock.value += 2;
    await rpcError(() => h.handlers.onrequestdisplaymode({ mode: 'fullscreen' }));
    expect(h.spies.setDisplayMode).toHaveBeenCalledTimes(1);

    state.gesture = h.clock.value;
    await expect(h.handlers.onrequestdisplaymode({ mode: 'fullscreen' })).resolves.toEqual({ mode: 'fullscreen' });
    expect(h.spies.setDisplayMode).toHaveBeenCalledTimes(2);
  });

  it('still lets the app go back to inline inside the cool-down', async () => {
    const state: { exit?: number } = {};
    const h = harness({ lastUserExitAt: () => state.exit });
    await h.handlers.onrequestdisplaymode({ mode: 'fullscreen' });
    state.exit = h.clock.value;
    await expect(h.handlers.onrequestdisplaymode({ mode: 'inline' })).resolves.toEqual({ mode: 'inline' });
  });

  it('audits a denied fullscreen request instead of failing silently', async () => {
    const h = harness();
    await h.handlers.onrequestdisplaymode({ mode: 'fullscreen' });
    await rpcError(() => h.handlers.onrequestdisplaymode({ mode: 'fullscreen' }));
    expect(h.audit).toMatchObject([{
      kind: 'display-mode',
      tool: 'ui/request-display-mode',
      args: { mode: 'fullscreen' },
      outcome: 'denied',
      isError: true,
      summary: FULLSCREEN_GESTURE_REQUIRED_MESSAGE,
    }]);
  });

  it('shares the per-minute action budget with tools/call', async () => {
    const h = harness();
    for (let i = 0; i < MAX_APP_TOOL_CALLS_PER_MINUTE; i++) {
      await h.handlers.oncalltool({ name: 'search', arguments: { query: `q${i}` } });
    }
    const error = await rpcError(() => h.handlers.onrequestdisplaymode({ mode: 'fullscreen' }));
    expect(error.code).toBe(-32001);
    expect(h.spies.onRateLimited).toHaveBeenCalledTimes(1);
    expect(h.spies.setDisplayMode).not.toHaveBeenCalled();
    expect(h.audit[h.audit.length - 1]).toMatchObject({ kind: 'display-mode', outcome: 'rate-limited', isError: true });
  });
});
