import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '../../types';
import { TOOL_NAMES } from './toolNames';

const mocks = vi.hoisted(() => ({
  isConnected: vi.fn().mockReturnValue(false),
  getServerTools: vi.fn().mockReturnValue([]),
  checkTool: vi.fn().mockReturnValue({ decision: 'allow' }),
}));

vi.mock('../mcp/client', () => ({
  mcpManager: {
    isConnected: mocks.isConnected,
    getServerTools: mocks.getServerTools,
    listTools: () => [],
  },
}));

vi.mock('../enterprise/policy/matcher', () => ({
  checkTool: (...args: unknown[]) => mocks.checkTool(...args),
}));

vi.mock('../enterprise/policy/enforcer', () => ({
  getCurrentPolicy: () => null,
}));

import { toolRegistry } from './registry';
import { useMCPStore } from '../../stores/mcpStore';
import { useSettingsStore } from '../../stores/settingsStore';
import {
  computeCapabilitySnapshot,
  classifyMcpErrorCategory,
  sanitizeMcpError,
  summarizeMcpConnectionError,
} from './capabilitySnapshot';

function makeTool(name: string, isConcurrencySafe?: ToolDefinition['isConcurrencySafe']): ToolDefinition {
  return {
    name,
    description: 'test tool',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => 'ok',
    isConcurrencySafe,
  };
}

const registeredNames: string[] = [];
function register(tool: ToolDefinition): void {
  toolRegistry.register(tool);
  registeredNames.push(tool.name);
}

describe('computeCapabilitySnapshot', () => {
  beforeEach(() => {
    mocks.isConnected.mockReturnValue(false);
    mocks.getServerTools.mockReturnValue([]);
    mocks.checkTool.mockReturnValue({ decision: 'allow' });
    useMCPStore.setState({ servers: {}, isLoading: false });
  });

  afterEach(() => {
    for (const name of registeredNames.splice(0)) {
      toolRegistry.remove(name);
    }
    vi.clearAllMocks();
  });

  it('reports a normal builtin tool as active with the right concurrency classification', () => {
    register(makeTool('safe_tool', true));
    register(makeTool('unsafe_tool', false));
    register(makeTool('conditional_tool', (input) => input.x === 1));

    const snapshot = computeCapabilitySnapshot();
    const byName = Object.fromEntries(snapshot.entries.map((e) => [e.name, e]));

    expect(byName.safe_tool).toMatchObject({
      source: { kind: 'builtin' },
      unavailableReasons: [],
      concurrencySafety: 'safe',
    });
    expect(byName.unsafe_tool.concurrencySafety).toBe('unsafe');
    expect(byName.conditional_tool.concurrencySafety).toBe('input-dependent');
  });

  it('marks create_todo unavailable with the real Labs gate reason (todos-inbox experiment is unregistered)', () => {
    register(makeTool(TOOL_NAMES.CREATE_TODO, true));

    const snapshot = computeCapabilitySnapshot();
    const entry = snapshot.entries.find((e) => e.name === TOOL_NAMES.CREATE_TODO);

    expect(entry?.unavailableReasons).toEqual([
      { kind: 'labs-gated', experimentId: 'todos-inbox' },
    ]);
  });

  it('reports a connected MCP server tool as active, sourced to its server', () => {
    useMCPStore.setState({
      servers: {
        github: {
          config: { name: 'github', enabled: true },
          status: 'connected',
          tools: [{ name: 'github__search_issues' }],
        },
      },
      isLoading: false,
    });

    const snapshot = computeCapabilitySnapshot();
    const entry = snapshot.entries.find((e) => e.name === 'github__search_issues');

    expect(entry).toMatchObject({
      source: { kind: 'mcp', server: 'github' },
      unavailableReasons: [],
    });
  });

  it('reports a disabled MCP server tool as unavailable', () => {
    useMCPStore.setState({
      servers: {
        slack: {
          config: { name: 'slack', enabled: false },
          status: 'disconnected',
          tools: [{ name: 'slack__post_message' }],
        },
      },
      isLoading: false,
    });

    const snapshot = computeCapabilitySnapshot();
    const entry = snapshot.entries.find((e) => e.name === 'slack__post_message');

    expect(entry?.unavailableReasons).toEqual([
      { kind: 'mcp-disabled', server: 'slack' },
    ]);
  });

  it('reports an errored MCP server tool with its connection status and a SANITIZED error category (never the raw error)', () => {
    useMCPStore.setState({
      servers: {
        notion: {
          config: { name: 'notion', enabled: true },
          status: 'error',
          error: 'ECONNREFUSED',
          tools: [{ name: 'notion__query' }],
        },
      },
      isLoading: false,
    });

    const snapshot = computeCapabilitySnapshot();
    const entry = snapshot.entries.find((e) => e.name === 'notion__query');

    expect(entry?.unavailableReasons).toEqual([
      { kind: 'mcp-not-connected', server: 'notion', status: 'error', error: 'connection-refused' },
    ]);
  });

  it('never leaks a raw MCP connection error (URL query token / absolute path) into the reported reason', () => {
    useMCPStore.setState({
      servers: {
        leaky: {
          config: { name: 'leaky', enabled: true },
          status: 'error',
          error: 'fetch failed: https://mcp.example.com/sse?token=sk-super-secret-abc123 (config at /Users/shawn/.abu/mcp/leaky.json)',
          tools: [{ name: 'leaky__do_thing' }],
        },
      },
      isLoading: false,
    });

    const snapshot = computeCapabilitySnapshot();
    const entry = snapshot.entries.find((e) => e.name === 'leaky__do_thing');
    const reason = entry?.unavailableReasons.find((r) => r.kind === 'mcp-not-connected');

    expect(reason?.kind).toBe('mcp-not-connected');
    const errorText = reason && reason.kind === 'mcp-not-connected' ? reason.error : undefined;
    expect(errorText).toBeDefined();
    expect(errorText).not.toContain('?');
    expect(errorText).not.toContain('/Users/');
    expect(errorText).not.toContain('sk-super-secret-abc123');
    expect(errorText).not.toContain('token=');
  });

  it('filters a Playwright browser tool as a duplicate when an Abu browser is connected', () => {
    mocks.isConnected.mockImplementation((name: string) => name === 'abu-browser');
    useMCPStore.setState({
      servers: {
        playwright: {
          config: { name: 'playwright', enabled: true },
          status: 'connected',
          tools: [{ name: 'playwright__browser_click' }],
        },
      },
      isLoading: false,
    });

    const snapshot = computeCapabilitySnapshot();
    const entry = snapshot.entries.find((e) => e.name === 'playwright__browser_click');

    expect(entry?.unavailableReasons).toEqual([
      { kind: 'duplicate-browser-tool', server: 'playwright' },
    ]);
  });

  it('does NOT filter a Playwright browser tool when no Abu browser is connected', () => {
    mocks.isConnected.mockReturnValue(false);
    useMCPStore.setState({
      servers: {
        playwright: {
          config: { name: 'playwright', enabled: true },
          status: 'connected',
          tools: [{ name: 'playwright__browser_click' }],
        },
      },
      isLoading: false,
    });

    const snapshot = computeCapabilitySnapshot();
    const entry = snapshot.entries.find((e) => e.name === 'playwright__browser_click');

    expect(entry?.unavailableReasons).toEqual([]);
  });

  it('gives builtin tools priority over an MCP tool of the same name', () => {
    register(makeTool('shared_name', true));
    useMCPStore.setState({
      servers: {
        someserver: {
          config: { name: 'someserver', enabled: true },
          status: 'connected',
          tools: [{ name: 'shared_name' }],
        },
      },
      isLoading: false,
    });

    const snapshot = computeCapabilitySnapshot();
    const matches = snapshot.entries.filter((e) => e.name === 'shared_name');

    expect(matches).toHaveLength(1);
    expect(matches[0].source).toEqual({ kind: 'builtin' });
  });

  it('surfaces an enterprise policy deny as an unavailable reason', () => {
    register(makeTool('blocked_tool', true));
    mocks.checkTool.mockImplementation((_policy: unknown, name: string) =>
      name === 'blocked_tool' ? { decision: 'deny', reason: 'not allowed by org policy' } : { decision: 'allow' },
    );

    const snapshot = computeCapabilitySnapshot();
    const entry = snapshot.entries.find((e) => e.name === 'blocked_tool');

    expect(entry?.unavailableReasons).toContainEqual({
      kind: 'policy-denied',
      reason: 'not allowed by org policy',
    });
  });

  it('keeps a "confirm" policy tool active but records the decision', () => {
    register(makeTool('needs_confirm_tool', true));
    mocks.checkTool.mockImplementation((_policy: unknown, name: string) =>
      name === 'needs_confirm_tool' ? { decision: 'confirm', reason: 'sensitive action' } : { decision: 'allow' },
    );

    const snapshot = computeCapabilitySnapshot();
    const entry = snapshot.entries.find((e) => e.name === 'needs_confirm_tool');

    expect(entry?.unavailableReasons).toEqual([]);
    expect(entry?.policy).toEqual({ decision: 'confirm', reason: 'sensitive action' });
  });

  it('passes through the real permissionMode and computerUseEnabled from settingsStore', () => {
    useSettingsStore.setState({ permissionMode: 'autonomous', computerUseEnabled: true });

    const snapshot = computeCapabilitySnapshot();

    expect(snapshot.permissionMode).toBe('autonomous');
    expect(snapshot.computerUseEnabled).toBe(true);
  });
});

describe('classifyMcpErrorCategory', () => {
  it.each([
    ['ECONNREFUSED', 'connection-refused'],
    ['connect ECONNREFUSED 127.0.0.1:9999', 'connection-refused'],
    ['request timed out', 'timeout'],
    ['ETIMEDOUT', 'timeout'],
    ['getaddrinfo ENOTFOUND mcp.example.com', 'dns-failure'],
    ['401 Unauthorized', 'auth-failed'],
    ['403 Forbidden: invalid API key', 'auth-failed'],
    ['spawn npx ENOENT', 'not-found'],
    ['EACCES: permission denied', 'permission-denied'],
    ['some completely unrecognized shape of error', 'unknown'],
  ] as const)('classifies %j as %s', (raw, expected) => {
    expect(classifyMcpErrorCategory(raw)).toBe(expected);
  });
});

describe('sanitizeMcpError — leak prevention for the RECEIVER of a raw connection error', () => {
  it('strips a URL query string entirely, including a bearer token', () => {
    const out = sanitizeMcpError('fetch failed: https://mcp.example.com/sse?token=sk-secret-123&foo=bar');
    expect(out).not.toContain('?');
    expect(out).not.toContain('token=');
    expect(out).not.toContain('sk-secret-123');
  });

  it('reduces an absolute Unix path to just its basename', () => {
    const out = sanitizeMcpError('ENOENT: no such file or directory, open \'/Users/shawn/.abu/mcp/config.json\'');
    expect(out).not.toContain('/Users/');
    expect(out).toContain('config.json');
  });

  it('reduces an absolute Windows path to just its basename', () => {
    const out = sanitizeMcpError('ENOENT: cannot open C:\\Users\\shawn\\AppData\\mcp\\config.json');
    expect(out).not.toContain('C:\\Users\\');
    expect(out).toContain('config.json');
  });

  it('truncates an overly long error to a bounded length', () => {
    const out = sanitizeMcpError('x'.repeat(500));
    expect(out.length).toBeLessThanOrEqual(161); // 160 chars + ellipsis
  });

  it('leaves an already-short, already-safe string untouched', () => {
    expect(sanitizeMcpError('server closed the connection')).toBe('server closed the connection');
  });
});

describe('summarizeMcpConnectionError', () => {
  it('returns undefined for undefined input', () => {
    expect(summarizeMcpConnectionError(undefined)).toBeUndefined();
  });

  it('prefers the coarse category over the sanitized raw string when recognized', () => {
    expect(summarizeMcpConnectionError('connect ECONNREFUSED 127.0.0.1:9999')).toBe('connection-refused');
  });

  it('falls back to the sanitized string when the shape is unrecognized, still leak-free', () => {
    const out = summarizeMcpConnectionError('weird backend said: /Users/shawn/secret/path?apikey=xyz');
    expect(out).not.toContain('?');
    expect(out).not.toContain('/Users/');
    expect(out).not.toContain('xyz');
  });
});
