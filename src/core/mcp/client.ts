// MCP Client Manager
// Stdio transport uses Tauri Rust backend for child process management.
// HTTP transports (StreamableHTTP, SSE) use the MCP SDK directly.

import type { ToolDefinition, ToolExecutionContext, ToolParameter, ToolResult, ToolResultContent } from '../../types';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { expandConfigEnvVars } from '@/utils/envExpansion';
import { hasEmbeddedNode } from '@/utils/nodeRuntime';
import { getTauriFetch } from '@/core/llm/tauriFetch';
import { createLogger } from '@/core/logging/logger';
import { isEnterpriseModuleActive } from '@/core/enterprise/entitlement';

const mcpLogger = createLogger('mcp');
const ENTERPRISE_SERVER_PREFIX = 'enterprise__';

/**
 * MCP request `_meta` key carrying the owning conversation id. Mirrors
 * `ABU_CONVERSATION_META_KEY` exported from `abu-browser-bridge/src/tools.ts`
 * (duplicated here rather than imported — abu-browser-bridge is published to
 * npm separately and isn't a workspace dependency of this app).
 */
const ABU_CONVERSATION_META_KEY = 'abu/conversationId';

/**
 * MCP request `_meta` key that turns off `get_tabs`' "provision a tab when the
 * caller owns none" behavior. Rides `_meta` rather than the tool's arguments
 * on purpose: it is a host-side probe concern, and putting it in the schema
 * would expose it to the model. Mirrors `ABU_CREATE_IF_EMPTY_META_KEY` in
 * `abu-browser-bridge/src/tools.ts` (same duplication rationale as above).
 */
const ABU_CREATE_IF_EMPTY_META_KEY = 'abu/createIfEmpty';

/**
 * MCP request `_meta` key carrying the SUBAGENT RUN that issued the call. The
 * browser host owns tabs by the pair `{conversationId, runKey}` (N6), so the
 * conversation id above is only half the owner: without this, a conversation's
 * own loop and each of its delegated subagent runs share one tab pool and one
 * "current tab" and steal each other's pages. Absent ⇒ the conversation's own
 * loop (the host reads that as `main`). Mirrors `ABU_RUN_META_KEY` in
 * `abu-browser-bridge/src/tools.ts` (same duplication rationale as above).
 */
const ABU_RUN_META_KEY = 'abu/runKey';

/**
 * The Chrome-extension bridge. Named here because it is the one MCP server
 * whose tab bookkeeping outlives a single tool call, so the app has to tell it
 * when a run is over. (`abu-browser` — the built-in Electron host — is told the
 * same thing over IPC instead; see `browserViewLifecycle.ts`.)
 */
const CHROME_BRIDGE_SERVER_NAME = 'abu-browser-bridge';

/**
 * MCP notification method the bridge answers by dropping one run's tab claims.
 * Mirrors `ABU_RUN_SETTLED_NOTIFICATION` in `abu-browser-shared/types.ts`
 * (duplicated, same rationale as the `_meta` keys above).
 *
 * A notification, not a tool call: tools are listed to the model, and a
 * model-callable "release" would invite one task to free a tab another task is
 * driving.
 */
const ABU_RUN_SETTLED_NOTIFICATION = 'notifications/abu/runSettled';

/**
 * Run key for a conversation's own loop — the other half of the browser tab
 * owner pair when there is no subagent run. Sent EXPLICITLY at a settlement:
 * the bridge's release protocol reads an absent run key as "every run of the
 * conversation", which is conversation-delete scope and would strip sibling
 * delegations of tabs they are still driving.
 */
const MAIN_RUN_KEY = 'main';

/**
 * The `{conversationId, runKey}` pair as one map key. NUL-separated, like the
 * host's own composite owner key: neither id can contain it, so two different
 * pairs can never collide into one.
 */
function browserRunOwnerKey(conversationId: string, agentRunId?: string): string {
  return `${conversationId}\u0000${agentRunId || MAIN_RUN_KEY}`;
}

/**
 * Map a tool's runtime ToolExecutionContext to callTool() opts. Factored out
 * of the execute() closure built during tool discovery so the mapping is
 * directly unit-testable — the discovery flow itself depends on the MCP SDK,
 * which the test environment stubs out entirely.
 */
export function toCallToolOpts(
  context?: ToolExecutionContext
): { conversationId?: string; agentRunId?: string; signal?: AbortSignal } {
  return {
    conversationId: context?.conversationId,
    agentRunId: context?.agentRunId,
    signal: context?.abortSignal,
  };
}

function isEnterpriseServerBlocked(name: string): boolean {
  return name.startsWith(ENTERPRISE_SERVER_PREFIX) && !isEnterpriseModuleActive('mcp');
}

export interface MCPServerConfig {
  name: string;
  transport?: 'stdio' | 'http';
  // stdio transport
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // http transport
  url?: string;
  headers?: Record<string, string>;
  // common
  enabled?: boolean;
  timeout?: number; // tool call timeout in ms, default 30000
}

export interface MCPServerStatus {
  name: string;
  connected: boolean;
  tools: string[];
  error?: string;
}

interface ConnectedServer {
  config: MCPServerConfig;
  client: unknown;
  transport: unknown;
  tools: Map<string, ToolDefinition>;
}

// ============================================================
// TauriStdioTransport — MCP Transport over Tauri IPC
// Uses Rust backend (mcp_spawn/mcp_write/mcp_kill) instead of
// Node.js child_process. Implements the MCP Transport interface.
// ============================================================

interface JSONRPCMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

class TauriStdioTransport {
  private processId: string;
  private config: { command: string; args: string[]; env: Record<string, string> };
  private unlisteners: UnlistenFn[] = [];

  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  onstderr?: (line: string) => void;

  constructor(config: { command: string; args: string[]; env: Record<string, string> }) {
    this.processId = `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.config = config;
  }

  async start(): Promise<void> {
    // Listen for JSON-RPC messages from stdout
    const unlisten1 = await listen<string>(`mcp-msg-${this.processId}`, (event) => {
      try {
        const message = JSON.parse(event.payload) as JSONRPCMessage;
        this.onmessage?.(message);
      } catch (err) {
        this.onerror?.(new Error(`Failed to parse MCP message: ${err}`));
      }
    });

    // Listen for stderr (log + callback)
    const unlisten2 = await listen<string>(`mcp-err-${this.processId}`, (event) => {
      console.warn(`[MCP stderr] ${event.payload}`);
      this.onstderr?.(event.payload);
    });

    // Listen for process close
    const unlisten3 = await listen<string>(`mcp-close-${this.processId}`, () => {
      this.onclose?.();
    });

    this.unlisteners = [unlisten1, unlisten2, unlisten3];

    // Spawn the process via Tauri backend
    await invoke('mcp_spawn', {
      id: this.processId,
      command: this.config.command,
      args: this.config.args,
      env: this.config.env,
    });

    console.log(`[MCP] TauriStdioTransport started: ${this.config.command} (id: ${this.processId})`);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const json = JSON.stringify(message);
    await invoke('mcp_write', { id: this.processId, message: json });
  }

  async close(): Promise<void> {
    for (const unlisten of this.unlisteners) {
      unlisten();
    }
    this.unlisteners = [];
    await invoke('mcp_kill', { id: this.processId });
    console.log(`[MCP] TauriStdioTransport closed: ${this.processId}`);
  }
}

// ============================================================
// MCP SDK dynamic imports — only HTTP transports
// ============================================================

let Client: typeof import('@modelcontextprotocol/sdk/client/index.js').Client | null = null;
let StreamableHTTPClientTransport: typeof import('@modelcontextprotocol/sdk/client/streamableHttp.js').StreamableHTTPClientTransport | null = null;
let SSEClientTransport: typeof import('@modelcontextprotocol/sdk/client/sse.js').SSEClientTransport | null = null;
// CSP-safe JSON-Schema validator. The SDK's default (ajv) compiles a tool's
// outputSchema via `new Function`, which the packaged app's CSP (script-src has
// 'unsafe-inline' but not 'unsafe-eval') blocks — that thrown error rejects
// listTools() and turns any connector whose tools declare an outputSchema into
// an Error state in release builds. CfWorkerJsonSchemaValidator validates
// without code generation (built for eval-restricted runtimes), so it stays
// CSP-safe while keeping real output-schema validation. Injected into every
// Client via createMcpClient().
let cspSafeValidator: InstanceType<
  typeof import('@modelcontextprotocol/sdk/validation/cfworker').CfWorkerJsonSchemaValidator
> | null = null;
let mcpAvailable = false;

async function loadMCPSDK(): Promise<boolean> {
  if (mcpAvailable) return true;

  const [clientResult, streamableResult, sseResult, cfworkerResult] = await Promise.allSettled([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    import('@modelcontextprotocol/sdk/client/sse.js'),
    import('@modelcontextprotocol/sdk/validation/cfworker'),
  ]);

  // Core Client — required
  if (clientResult.status === 'fulfilled') {
    Client = clientResult.value.Client;
    console.log('[MCP] Client loaded');
  } else {
    console.log('[MCP] Client not available:', clientResult.reason);
    return false;
  }

  // CSP-safe validator — preferred so listTools() doesn't trip ajv's `new Function`
  // under the packaged app's CSP. OPTIONAL, not required: if it can't load or
  // construct, leave cspSafeValidator null so createMcpClient() falls back to the
  // SDK default (ajv). That degrades gracefully — only outputSchema connectors
  // risk the CSP error again — instead of disabling ALL MCP (incl. stdio/HTTP
  // connectors with no outputSchema, which never touch the validator).
  if (cfworkerResult.status === 'fulfilled') {
    try {
      cspSafeValidator = new cfworkerResult.value.CfWorkerJsonSchemaValidator();
      console.log('[MCP] CSP-safe validator loaded');
    } catch (err) {
      console.warn('[MCP] CSP-safe validator failed to construct, falling back to SDK default:', err);
    }
  } else {
    console.warn('[MCP] CSP-safe validator not available, falling back to SDK default:', cfworkerResult.reason);
  }

  // HTTP transports — optional
  if (streamableResult.status === 'fulfilled') {
    StreamableHTTPClientTransport = streamableResult.value.StreamableHTTPClientTransport;
    console.log('[MCP] StreamableHTTP transport loaded');
  }

  if (sseResult.status === 'fulfilled') {
    SSEClientTransport = sseResult.value.SSEClientTransport;
    console.log('[MCP] SSE transport loaded');
  }

  mcpAvailable = true;
  console.log('[MCP] SDK loaded successfully');
  return true;
}

/**
 * Construct an MCP Client with shared client info and the CSP-safe validator.
 * Centralizing this ensures every transport (stdio / StreamableHTTP / SSE) gets
 * the eval-free validator — a copy-pasted Client site that forgets it would
 * re-introduce the packaged-app CSP failure. Callers must ensure loadMCPSDK()
 * succeeded (Client + cspSafeValidator are non-null after it returns true).
 */
function createMcpClient(): InstanceType<NonNullable<typeof Client>> {
  if (!Client) throw new Error('MCP Client not loaded');
  return new Client(
    { name: 'abu-desktop', version: '0.1.0' },
    { capabilities: {}, jsonSchemaValidator: cspSafeValidator ?? undefined }
  );
}

/** Determine effective transport type from config */
function getTransportType(config: MCPServerConfig): 'stdio' | 'http' {
  if (config.transport) return config.transport;
  if (config.url) return 'http';
  return 'stdio';
}

interface MCPToolDetail {
  name: string;
  description?: string;
}

const RECONNECT_DELAYS = [2000, 5000, 15000]; // 3 attempts: 2s, 5s, 15s
const MAX_LOG_LINES = 200; // Ring buffer size per server

export interface MCPLogEntry {
  timestamp: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

// ============================================================
// Schema helpers — shared by connectServer + refreshServerTools
// ============================================================

/** Extract the primary type string from a JSON Schema property (handles type arrays) */
function getPropType(prop: Record<string, unknown>): string {
  const t = prop.type;
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) {
    // e.g. ["number", "null"] — pick first non-null entry
    const nonNull = (t as string[]).find((x) => x !== 'null');
    return nonNull ?? 'string';
  }
  return 'string';
}

/** Build ToolParameter map from an MCP inputSchema */
function buildToolProperties(
  inputSchema: { properties?: Record<string, Record<string, unknown>>; required?: string[] },
): Record<string, ToolParameter> {
  const properties: Record<string, ToolParameter> = {};
  if (inputSchema.properties) {
    for (const [key, prop] of Object.entries(inputSchema.properties)) {
      properties[key] = {
        ...prop,
        type: getPropType(prop),
        description: (prop.description as string) ?? '',
      } as ToolParameter;
    }
  }
  return properties;
}

/**
 * Coerce string values → number where the tool schema declares a numeric type.
 * LLMs occasionally pass large integer IDs (e.g. Chrome tabId) as quoted strings.
 * Returns the original object unchanged if no coercion was needed.
 */
function coerceNumericArgs(
  tool: ToolDefinition,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const props = tool.inputSchema?.properties;
  if (!props) return args;

  let changed = false;
  const result: Record<string, unknown> = { ...args };

  for (const [key, param] of Object.entries(props)) {
    const type = (param as ToolParameter).type;
    const isNumeric = type === 'number' || type === 'integer';
    if (isNumeric && typeof result[key] === 'string') {
      const coerced = Number(result[key]);
      if (!isNaN(coerced)) {
        result[key] = coerced;
        changed = true;
      }
    }
  }

  return changed ? result : args;
}

export class MCPClientManager {
  private servers: Map<string, ConnectedServer> = new Map();
  private listeners: Set<() => void> = new Set();
  private reconnectAttempts: Map<string, number> = new Map();
  private reconnectTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private serverLogs: Map<string, MCPLogEntry[]> = new Map();
  /**
   * `{conversationId, runKey}` pairs that have called a Chrome-bridge tool and
   * have not been told they are over yet.
   *
   * Only these get a settlement notification. Every run would otherwise wake
   * the bridge process at its seal, including the overwhelming majority that
   * never opened a browser — and the release itself is a no-op for them, since
   * a run that never drove a tab holds no claim.
   */
  private browserBridgeRunOwners: Set<string> = new Set();

  subscribe(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private notifyListeners() {
    this.listeners.forEach((cb) => cb());
  }

  async connectServer(config: MCPServerConfig): Promise<void> {
    if (this.servers.has(config.name)) {
      // Disconnect the old one first to avoid zombie processes
      console.log(`[MCP] Server ${config.name} already exists, disconnecting old instance first`);
      await this.disconnectServer(config.name);
    }

    const available = await loadMCPSDK();
    if (!available || !Client) {
      throw new Error('MCP SDK 加载失败，请检查依赖是否正确安装');
    }

    // Expand ${VAR} references in config
    const expandedConfig = await expandConfigEnvVars(config);
    const transportType = getTransportType(expandedConfig);

    try {
      console.log(`[MCP] Connecting to server: ${config.name} (${transportType})`);

      let transport: unknown;
      let client: InstanceType<typeof Client>;

      if (transportType === 'http') {
        if (!expandedConfig.url) {
          throw new Error('HTTP transport requires a URL');
        }
        // HTTP: use connectHTTPWithFallback (StreamableHTTP → SSE, with Tauri fetch for CORS)
        const result = await this.connectHTTPWithFallback(expandedConfig, config.name);
        transport = result.transport;
        client = result.client as InstanceType<typeof Client>;
      } else {
        // Stdio — use TauriStdioTransport (Rust backend manages the child process)
        if (!expandedConfig.command) {
          throw new Error('Stdio transport requires a command');
        }
        // Pre-check: if command is npx/node, verify Node.js is available.
        // Abu bundles a Node.js runtime (see nodeRuntime.ts / mcp_spawn PATH
        // fallback), so a missing system Node is only fatal when the bundled
        // runtime is also absent (e.g. a dev checkout without `npm run setup-node`).
        const cmd = expandedConfig.command;
        if (cmd === 'npx' || cmd === 'node' || cmd === 'npm') {
          if (!(await hasEmbeddedNode())) {
            try {
              await invoke('run_shell_command', { command: 'node --version', cwd: null, background: false, timeout: 5 });
            } catch {
              throw new Error(
                `未检测到 Node.js 环境。${cmd} 命令需要先安装 Node.js。\n请访问 https://nodejs.org 下载安装后重试。`
              );
            }
          }
        }
        transport = new TauriStdioTransport({
          command: expandedConfig.command,
          args: expandedConfig.args ?? [],
          env: expandedConfig.env ?? {},
        });

        // Create MCP client and connect for stdio
        client = createMcpClient();
        await client.connect(transport as Parameters<typeof client.connect>[0]);
      }

      // Discover tools
      const toolsResponse = await client.listTools();
      const tools = new Map<string, ToolDefinition>();

      for (const tool of toolsResponse.tools) {
        const inputSchema = tool.inputSchema as {
          type: 'object';
          properties?: Record<string, Record<string, unknown>>;
          required?: string[];
        };

        const properties = buildToolProperties(inputSchema);

        const toolDef: ToolDefinition = {
          name: `${config.name}__${tool.name}`,
          description: tool.description ?? '',
          inputSchema: {
            type: 'object',
            properties,
            required: inputSchema.required,
          },
          execute: async (input, context) => {
            return this.callTool(config.name, tool.name, input, toCallToolOpts(context));
          },
        };

        tools.set(tool.name, toolDef);
      }

      this.servers.set(config.name, { config, client, transport, tools });

      // Reset reconnect counter on successful connection
      this.reconnectAttempts.delete(config.name);

      this.addLog(config.name, 'info', `Connected, discovered ${tools.size} tools`);

      // Set up onclose + stderr handlers (stdio transport)
      if (transportType === 'stdio' && transport instanceof TauriStdioTransport) {
        // Capture stderr as server logs
        transport.onstderr = (line) => {
          this.addLog(config.name, 'warn', line);
        };
        const origOnClose = transport.onclose;
        transport.onclose = () => {
          origOnClose?.();
          this.handleServerDisconnect(config.name);
        };
      }

      mcpLogger.info('MCP server connected', { name: config.name, toolCount: tools.size });
      console.log(`[MCP] Connected to ${config.name}, discovered ${tools.size} tools`);
      this.notifyListeners();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      mcpLogger.error('MCP server connection failed', { name: config.name, error: errorMessage });
      console.error(`[MCP] Failed to connect to ${config.name}:`, err);
      throw err;
    }
  }

  /**
   * Connect via HTTP with automatic StreamableHTTP → SSE fallback.
   * Uses Tauri fetch to bypass CORS in the webview.
   */
  private async connectHTTPWithFallback(
    config: MCPServerConfig,
    displayName: string
  ): Promise<{ transport: unknown; client: unknown }> {
    if (!Client) throw new Error('MCP Client not loaded');

    const url = new URL(config.url!);
    const tauriFetch = await getTauriFetch();
    const transportOpts = {
      fetch: tauriFetch as unknown as typeof globalThis.fetch,
      requestInit: config.headers ? { headers: config.headers } : undefined,
    };

    let streamableErr: string | null = null;

    // Try StreamableHTTP first
    if (StreamableHTTPClientTransport) {
      try {
        this.addLog(displayName, 'info', 'Trying StreamableHTTP transport...');
        const transport = new StreamableHTTPClientTransport(url, transportOpts);
        const client = createMcpClient();
        await client.connect(transport as Parameters<typeof client.connect>[0]);
        this.addLog(displayName, 'info', 'Connected via StreamableHTTP');
        return { transport, client };
      } catch (err) {
        streamableErr = err instanceof Error ? err.message : String(err);
        this.addLog(displayName, 'warn', `StreamableHTTP failed: ${streamableErr}, trying SSE...`);
      }
    }

    // Fallback to SSE
    if (SSEClientTransport) {
      try {
        this.addLog(displayName, 'info', 'Trying SSE transport...');
        const transport = new SSEClientTransport(url, transportOpts);
        const client = createMcpClient();
        await client.connect(transport as Parameters<typeof client.connect>[0]);
        this.addLog(displayName, 'info', 'Connected via SSE');
        return { transport, client };
      } catch (err) {
        const sseErr = err instanceof Error ? err.message : String(err);
        // Surface BOTH errors so users can see what really failed in StreamableHTTP,
        // not just the SSE fallback's content-type complaint.
        const combined = streamableErr
          ? `HTTP transport failed.\n  StreamableHTTP: ${streamableErr}\n  SSE fallback: ${sseErr}`
          : `SSE error: ${sseErr}`;
        throw new Error(combined, { cause: err });
      }
    }

    throw new Error(
      streamableErr
        ? `HTTP transport failed (StreamableHTTP only): ${streamableErr}`
        : 'No HTTP transport available (neither StreamableHTTP nor SSE)'
    );
  }

  /**
   * Handle unexpected server disconnection — clean up process, then auto-reconnect.
   */
  private handleServerDisconnect(name: string) {
    const server = this.servers.get(name);
    if (!server) return;

    // Don't reconnect temp test connections
    if (name.startsWith('__test_')) return;

    mcpLogger.warn('MCP server disconnected', { name });
    console.warn(`[MCP] Server ${name} disconnected unexpectedly`);

    // Kill the old child process to prevent zombie processes
    const transport = server.transport;
    if (transport instanceof TauriStdioTransport) {
      // Detach onclose to prevent re-entry
      transport.onclose = undefined;
      transport.close().catch((err) => {
        console.warn(`[MCP] Error killing old process for ${name}:`, err);
      });
    }

    this.servers.delete(name);
    this.forgetBrowserBridgeRunOwners(name);
    this.notifyListeners();

    // No auto-reconnect — user can manually reconnect from the Toolbox
    this.addLog(name, 'warn', 'Disconnected. Click reconnect to retry.');
  }

  /**
   * Schedule a reconnect attempt with exponential backoff.
   */
  private scheduleReconnect(name: string, config: MCPServerConfig) {
    const attempt = this.reconnectAttempts.get(name) ?? 0;
    if (attempt >= RECONNECT_DELAYS.length) {
      console.warn(`[MCP] Giving up reconnecting to ${name} after ${attempt} attempts`);
      this.reconnectAttempts.delete(name);
      return;
    }

    const delay = RECONNECT_DELAYS[attempt];
    console.log(`[MCP] Will reconnect to ${name} in ${delay / 1000}s (attempt ${attempt + 1}/${RECONNECT_DELAYS.length})`);
    this.reconnectAttempts.set(name, attempt + 1);

    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(name);
      try {
        await this.connectServer(config);
        console.log(`[MCP] Reconnected to ${name}`);
      } catch (err) {
        console.warn(`[MCP] Reconnect attempt ${attempt + 1} failed for ${name}:`, err);
        // Schedule next attempt
        this.scheduleReconnect(name, config);
      }
    }, delay);

    this.reconnectTimers.set(name, timer);
  }

  /**
   * Append a log entry for a server (ring buffer).
   */
  addLog(serverName: string, level: MCPLogEntry['level'], message: string) {
    let logs = this.serverLogs.get(serverName);
    if (!logs) {
      logs = [];
      this.serverLogs.set(serverName, logs);
    }
    logs.push({ timestamp: Date.now(), level, message });
    if (logs.length > MAX_LOG_LINES) {
      logs.splice(0, logs.length - MAX_LOG_LINES);
    }
  }

  /**
   * Get logs for a server.
   */
  getServerLogs(serverName: string): MCPLogEntry[] {
    return this.serverLogs.get(serverName) ?? [];
  }

  /**
   * Clear logs for a server.
   */
  clearServerLogs(serverName: string) {
    this.serverLogs.delete(serverName);
  }

  /**
   * Get detailed tool info (name + description) for a server.
   */
  getServerToolDetails(serverName: string): MCPToolDetail[] {
    const server = this.servers.get(serverName);
    if (!server) return [];
    return Array.from(server.tools.values()).map((t) => ({
      name: t.name.replace(`${serverName}__`, ''),
      description: t.description || undefined,
    }));
  }

  /**
   * Test connection to a server config without persisting the connection.
   * Returns { success, message } with tool count on success.
   */
  async testConnection(config: MCPServerConfig): Promise<{ success: boolean; toolCount?: number; error?: string }> {
    const tempName = `__test_${Date.now()}`;
    const tempConfig = { ...config, name: tempName };

    try {
      await this.connectServer(tempConfig);
      const toolCount = this.servers.get(tempName)?.tools.size ?? 0;
      await this.disconnectServer(tempName);
      // Clean up any logs/reconnect state for the temp name
      this.serverLogs.delete(tempName);
      return { success: true, toolCount };
    } catch (err) {
      // Make sure temp connection is cleaned up
      await this.disconnectServer(tempName).catch(() => {});
      this.serverLogs.delete(tempName);
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }

  async disconnectServer(name: string): Promise<void> {
    // Cancel any pending reconnect
    const timer = this.reconnectTimers.get(name);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(name);
    }
    this.reconnectAttempts.delete(name);

    const server = this.servers.get(name);
    if (!server) return;

    try {
      const client = server.client as { close: () => Promise<void> };
      await client.close();
    } catch (err) {
      console.error(`[MCP] Error disconnecting from ${name}:`, err);
    }
    this.servers.delete(name);
    this.forgetBrowserBridgeRunOwners(name);
    this.notifyListeners();
  }

  /**
   * The bridge process is gone, so every claim it was holding is gone with it
   * — the extension drops the lot when its socket closes. Keeping the owners
   * would only send a release to whichever bridge connects next, about runs it
   * never heard of.
   */
  private forgetBrowserBridgeRunOwners(name: string): void {
    if (name !== CHROME_BRIDGE_SERVER_NAME) return;
    this.browserBridgeRunOwners.clear();
  }

  async disconnectAll(): Promise<void> {
    // Clear all reconnect timers first
    for (const [name, timer] of this.reconnectTimers) {
      clearTimeout(timer);
      this.reconnectTimers.delete(name);
    }
    this.reconnectAttempts.clear();

    const names = Array.from(this.servers.keys());
    await Promise.all(names.map((name) => this.disconnectServer(name)));
  }

  listTools(): ToolDefinition[] {
    const allTools: ToolDefinition[] = [];
    for (const [name, server] of this.servers) {
      if (isEnterpriseServerBlocked(name)) continue;
      allTools.push(...server.tools.values());
    }
    return allTools;
  }

  getServerTools(serverName: string): ToolDefinition[] {
    if (isEnterpriseServerBlocked(serverName)) return [];
    const server = this.servers.get(serverName);
    return server ? Array.from(server.tools.values()) : [];
  }

  /**
   * Re-discover tools from a connected server without reconnecting.
   * Useful when the server's tool set changes during a session.
   * Returns the number of tools discovered, or -1 if server not connected.
   */
  async refreshServerTools(serverName: string): Promise<number> {
    if (isEnterpriseServerBlocked(serverName)) return -1;
    const server = this.servers.get(serverName);
    if (!server) return -1;

    try {
      const client = server.client as { listTools: () => Promise<{ tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> }> };
      const toolsResponse = await client.listTools();
      const tools = new Map<string, ToolDefinition>();

      for (const tool of toolsResponse.tools) {
        const inputSchema = tool.inputSchema as {
          type: 'object';
          properties?: Record<string, Record<string, unknown>>;
          required?: string[];
        };

        const properties = buildToolProperties(inputSchema);

        const config = server.config;
        const toolDef: ToolDefinition = {
          name: `${config.name}__${tool.name}`,
          description: tool.description ?? '',
          inputSchema: {
            type: 'object',
            properties,
            required: inputSchema.required,
          },
          execute: async (input, context) => {
            return this.callTool(config.name, tool.name, input, toCallToolOpts(context));
          },
        };

        tools.set(tool.name, toolDef);
      }

      const oldCount = server.tools.size;
      server.tools = tools;

      mcpLogger.info('MCP server tools refreshed', {
        name: serverName,
        oldCount,
        newCount: tools.size,
      });
      this.addLog(serverName, 'info', `Tools refreshed: ${oldCount} → ${tools.size}`);
      this.notifyListeners();
      return tools.size;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      mcpLogger.warn('MCP server tools refresh failed', { name: serverName, error: errorMessage });
      this.addLog(serverName, 'warn', `Tools refresh failed: ${errorMessage}`);
      return -1;
    }
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    opts?: {
      conversationId?: string;
      /**
       * The `sar-*` subagent run that issued the call, or omitted for the
       * conversation's own loop. Second half of the browser host's tab-owner
       * pair — see `ABU_RUN_META_KEY`.
       */
      agentRunId?: string;
      signal?: AbortSignal;
      /**
       * Only meaningful for the browser server's `get_tabs`: pass `false` for a
       * read-only probe that must not provision an automation view as a side
       * effect (the permission gate's origin lookup). Omitted ⇒ host default
       * (create), so every existing caller is unchanged.
       */
      createBrowserTabIfEmpty?: boolean;
    }
  ): Promise<ToolResult> {
    if (isEnterpriseServerBlocked(serverName)) {
      throw new Error('Enterprise MCP is not authorized by the current live session');
    }
    const server = this.servers.get(serverName);
    if (!server) {
      throw new Error(`Server ${serverName} not connected`);
    }

    // Coerce string → number for numeric-typed parameters before sending to MCP server.
    // LLMs occasionally pass large integer IDs (e.g. Chrome tabId) as quoted strings.
    const toolDef = server.tools.get(toolName);
    const coercedArgs = toolDef ? coerceNumericArgs(toolDef, args) : args;

    let timerId: ReturnType<typeof setTimeout>;
    try {
      const client = server.client as {
        callTool: (
          params: {
            name: string;
            arguments: Record<string, unknown>;
            _meta?: Record<string, unknown>;
          },
          resultSchema?: undefined,
          options?: { signal?: AbortSignal; timeout?: number }
        ) => Promise<{
          content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
        }>;
      };
      // Browser automation tools need longer timeouts (waiting for popups, page loads, etc.)
      const defaultTimeout = (
        serverName === 'abu-browser' || serverName === 'abu-browser-bridge'
      ) ? 120000 : 30000;
      const serverTimeout = server.config.timeout ?? defaultTimeout;
      const timeout = new Promise<never>((_, reject) => {
        timerId = setTimeout(() => reject(new Error(`MCP tool call timed out after ${serverTimeout / 1000}s: ${toolName}`)), serverTimeout);
      });
      const params: { name: string; arguments: Record<string, unknown>; _meta?: Record<string, unknown> } = {
        name: toolName,
        arguments: coercedArgs,
      };
      const meta: Record<string, unknown> = {};
      if (opts?.conversationId) {
        meta[ABU_CONVERSATION_META_KEY] = opts.conversationId;
      }
      // Only when there IS one: a main-loop call keeps its exact pre-N6 `_meta`
      // shape, and the host owns the "absent ⇒ main" default.
      if (opts?.agentRunId) {
        meta[ABU_RUN_META_KEY] = opts.agentRunId;
      }
      if (opts?.createBrowserTabIfEmpty === false) {
        meta[ABU_CREATE_IF_EMPTY_META_KEY] = false;
      }
      if (Object.keys(meta).length > 0) {
        params._meta = meta;
      }
      if (serverName === CHROME_BRIDGE_SERVER_NAME && opts?.conversationId) {
        // Recorded BEFORE the call, not after it succeeds: the extension
        // claims its target tab while resolving the request, so a call that
        // then times out or is cancelled has still left a claim behind.
        this.browserBridgeRunOwners.add(
          browserRunOwnerKey(opts.conversationId, opts.agentRunId)
        );
      }
      // Always pass `timeout` (not only when a signal is given): the SDK's
      // own request/response cycle has an internal default request timeout
      // (60s) that fires independently of the manual `Promise.race` above.
      // For browser servers, serverTimeout is 120s — without this, the SDK's
      // 60s default would reject `wait_for`-style long calls before our own
      // race ever gets a chance to.
      const result = await Promise.race([
        client.callTool(
          params,
          undefined,
          opts?.signal ? { signal: opts.signal, timeout: serverTimeout } : { timeout: serverTimeout }
        ),
        timeout,
      ]);
      clearTimeout(timerId!);

      if (result.content && Array.isArray(result.content)) {
        const hasImages = result.content.some((c) => c.type === 'image' && c.data);
        if (hasImages) {
          // Return rich content blocks so images are preserved for LLM and UI
          const blocks: ToolResultContent[] = result.content.map((c) => {
            if (c.type === 'image' && c.data) {
              return {
                type: 'image' as const,
                source: {
                  type: 'base64' as const,
                  media_type: c.mimeType ?? 'image/png',
                  data: c.data,
                },
              };
            }
            if (c.type === 'text') {
              return { type: 'text' as const, text: c.text ?? '' };
            }
            return { type: 'text' as const, text: JSON.stringify(c) };
          });
          return blocks;
        }
        // Text-only results — return as plain string
        return result.content
          .map((c) => {
            if (c.type === 'text') return c.text;
            return JSON.stringify(c);
          })
          .join('\n');
      }

      return JSON.stringify(result);
    } catch (err) {
      clearTimeout(timerId!);
      // The conversation run was stopped: the SDK already cancelled the
      // in-flight request (see toCallToolOpts/callTool's `signal` param) and
      // rejected promptly. Only browser automation servers get the friendlier
      // cancellation message shown to the model/user — other MCP servers keep
      // whatever error the SDK surfaced for its own abort handling.
      if (
        opts?.signal?.aborted &&
        (serverName === 'abu-browser' || serverName === 'abu-browser-bridge')
      ) {
        throw new Error('Browser action cancelled because the run was stopped.', { cause: err });
      }
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[MCP] Tool call failed: ${serverName}:${toolName}`, err);
      throw new Error(`Tool call failed: ${errorMsg}`, { cause: err });
    }
  }

  /**
   * Tell the Chrome bridge that one agent run is over, so it releases the
   * browser tabs that run claimed.
   *
   * Called at a run's settlement seal — the point after which the run can no
   * longer start another tool — for BOTH ways a run ends: it finished, or the
   * user stopped it. Deliberately not derived from the per-request abort the
   * bridge already sees: the MCP SDK aborts a tool handler for its own request
   * timeouts too, so acting on that would hand a still-running task's page to
   * another conversation (`abu-browser-bridge/src/wsServer.ts` has the full
   * note). This is the app saying it outright, once, at the one moment it is
   * certain.
   *
   * `agentRunId` omitted ⇒ the conversation's own loop, sent as the explicit
   * run key `main`. The notification never carries "every run of this
   * conversation": that is conversation-delete scope, and a settling
   * delegation must not strip its siblings — or the main loop — of tabs they
   * are still driving.
   *
   * Consequence worth stating: unlike the built-in host, whose `main` pool
   * survives between turns, a conversation's Chrome tab claim ends with the
   * run. The next turn re-claims on its first explicit `tabId` (and `get_tabs`
   * still lists the page, since the extension's listing is never filtered) —
   * one extra call, in exchange for not holding one of the USER's real tabs
   * hostage while nothing is running.
   *
   * Fire-and-forget and best-effort, like the built-in host's own dispose
   * calls: a failed release costs one stale claim, which the tab closing or
   * the socket dropping clears anyway, and a run must never fail or be held
   * open by its own bookkeeping.
   */
  notifyBrowserBridgeRunSettled(conversationId?: string, agentRunId?: string): void {
    if (!conversationId) return;
    const ownerKey = browserRunOwnerKey(conversationId, agentRunId);
    if (!this.browserBridgeRunOwners.delete(ownerKey)) return;

    const server = this.servers.get(CHROME_BRIDGE_SERVER_NAME);
    if (!server) return;
    const client = server.client as {
      notification?: (notification: { method: string; params?: unknown }) => Promise<void>;
    };
    if (typeof client.notification !== 'function') return;
    try {
      void Promise.resolve(
        client.notification({
          method: ABU_RUN_SETTLED_NOTIFICATION,
          params: { ownerId: conversationId, runId: agentRunId || MAIN_RUN_KEY },
        })
      ).catch((err) => {
        mcpLogger.debug('browser bridge run-settled notification failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } catch (err) {
      mcpLogger.debug('browser bridge run-settled notification threw', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  getStatus(): MCPServerStatus[] {
    const statuses: MCPServerStatus[] = [];
    for (const [name, server] of this.servers) {
      statuses.push({
        name,
        connected: true,
        tools: Array.from(server.tools.keys()),
      });
    }
    return statuses;
  }

  getConnectedServers(): string[] {
    return Array.from(this.servers.keys());
  }

  isConnected(serverName: string): boolean {
    return this.servers.has(serverName);
  }
}

// Singleton instance
export const mcpManager = new MCPClientManager();
