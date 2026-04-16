import type {
  ToolDefinition,
  ToolParameter,
  ToolResult,
  ToolResultContent,
} from '../../../../src/types';
import type { ProcessAdapter, ChildProcessHandle } from '../ports/adapters/process';
import type { FetchAdapter } from '../ports/adapters/fetch';
import type { LoggerAdapter } from '../ports/adapters/logger';
import type { ClockAdapter } from '../ports/adapters/clock';
import { scopedLogger } from '../logging/scopedLogger';

/**
 * 对比 Abu 原版改动：
 * - 原版 `TauriStdioTransport` 通过 `invoke('mcp_spawn'/...)` 调 Rust 后端；
 * - 新版 `StdioProcessTransport` 通过 ProcessAdapter 拉起子进程（Tauri 端可封装原来的 Rust 逻辑，
 *   Node 端走 `child_process.spawn`）；
 * - 原版 `getTauriFetch` 替换为 FetchAdapter；
 * - 原版环境变量展开（expandConfigEnvVars + 读 OS env）移出 core：config 要求预先展开；
 * - 原版 Node.js 预检（node --version）移出 core：由 shell 做；
 * - 原版 singleton `mcpManager` 移除，改为构造器 DI。
 */

export interface MCPServerConfig {
  name: string;
  transport?: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  timeout?: number;
}

export interface MCPServerStatus {
  name: string;
  connected: boolean;
  tools: string[];
  error?: string;
}

export interface MCPLogEntry {
  timestamp: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

const MAX_LOG_LINES = 200;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

// ─── JSON-RPC ───

interface JSONRPCMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ─── Transport abstraction ───

export interface McpTransport {
  start(): Promise<void>;
  send(message: JSONRPCMessage): Promise<void>;
  close(): Promise<void>;
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  onstderr?: (line: string) => void;
}

// ─── Stdio transport (via ProcessAdapter) ───

export class StdioProcessTransport implements McpTransport {
  private proc: ChildProcessHandle | null = null;
  private stdoutBuffer = '';

  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  onstderr?: (line: string) => void;

  constructor(
    private readonly process: ProcessAdapter,
    private readonly config: { command: string; args: string[]; env: Record<string, string> }
  ) {}

  async start(): Promise<void> {
    this.proc = await this.process.spawn({
      command: this.config.command,
      args: this.config.args,
      env: this.config.env,
    });

    this.proc.onStdout((chunk) => {
      this.stdoutBuffer += chunk;
      let nl;
      while ((nl = this.stdoutBuffer.indexOf('\n')) >= 0) {
        const line = this.stdoutBuffer.slice(0, nl).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as JSONRPCMessage;
          this.onmessage?.(msg);
        } catch (err) {
          this.onerror?.(new Error(`Failed to parse MCP message: ${err}`));
        }
      }
    });

    this.proc.onStderr((chunk) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) this.onstderr?.(line);
      }
    });

    this.proc.onExit(() => {
      this.onclose?.();
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.proc) throw new Error('Transport not started');
    await this.proc.write(JSON.stringify(message) + '\n');
  }

  async close(): Promise<void> {
    if (this.proc) {
      await this.proc.kill('SIGTERM');
      this.proc = null;
    }
  }
}

// ─── Schema helpers ───

function getPropType(prop: Record<string, unknown>): string {
  const t = prop.type;
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) {
    const nonNull = (t as string[]).find((x) => x !== 'null');
    return nonNull ?? 'string';
  }
  return 'string';
}

function buildToolProperties(inputSchema: {
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
}): Record<string, ToolParameter> {
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

function coerceNumericArgs(
  tool: ToolDefinition,
  args: Record<string, unknown>
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

// ─── Client manager ───

interface MCPSDKModules {
  Client: typeof import('@modelcontextprotocol/sdk/client/index.js').Client;
  StreamableHTTPClientTransport?: typeof import('@modelcontextprotocol/sdk/client/streamableHttp.js').StreamableHTTPClientTransport;
  SSEClientTransport?: typeof import('@modelcontextprotocol/sdk/client/sse.js').SSEClientTransport;
}

interface ConnectedServer {
  config: MCPServerConfig;
  client: InstanceType<MCPSDKModules['Client']>;
  transport: McpTransport | unknown;
  tools: Map<string, ToolDefinition>;
}

export interface MCPClientManagerDeps {
  process: ProcessAdapter;
  fetch: FetchAdapter;
  logger: LoggerAdapter;
  clock: ClockAdapter;
  /** 可选 MCP SDK 注入（便于测试）；默认动态 import */
  sdk?: MCPSDKModules | null;
  /** MCP client 标识 */
  clientName?: string;
  clientVersion?: string;
}

export class MCPClientManager {
  private servers = new Map<string, ConnectedServer>();
  private listeners = new Set<() => void>();
  private serverLogs = new Map<string, MCPLogEntry[]>();
  private sdkPromise: Promise<MCPSDKModules | null> | null = null;
  private readonly log: ReturnType<typeof scopedLogger>;

  constructor(private readonly deps: MCPClientManagerDeps) {
    this.log = scopedLogger(deps.logger, 'mcp');
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notifyListeners(): void {
    this.listeners.forEach((cb) => cb());
  }

  private async loadSDK(): Promise<MCPSDKModules | null> {
    if (this.deps.sdk !== undefined) return this.deps.sdk;
    if (!this.sdkPromise) {
      this.sdkPromise = (async () => {
        try {
          const [clientMod, streamableMod, sseMod] = await Promise.allSettled([
            import('@modelcontextprotocol/sdk/client/index.js'),
            import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
            import('@modelcontextprotocol/sdk/client/sse.js'),
          ]);
          if (clientMod.status !== 'fulfilled') return null;
          return {
            Client: clientMod.value.Client,
            StreamableHTTPClientTransport:
              streamableMod.status === 'fulfilled'
                ? streamableMod.value.StreamableHTTPClientTransport
                : undefined,
            SSEClientTransport:
              sseMod.status === 'fulfilled' ? sseMod.value.SSEClientTransport : undefined,
          };
        } catch {
          return null;
        }
      })();
    }
    return this.sdkPromise;
  }

  private getTransportType(config: MCPServerConfig): 'stdio' | 'http' {
    if (config.transport) return config.transport;
    if (config.url) return 'http';
    return 'stdio';
  }

  async connectServer(config: MCPServerConfig): Promise<void> {
    if (this.servers.has(config.name)) {
      await this.disconnectServer(config.name);
    }
    const sdk = await this.loadSDK();
    if (!sdk) throw new Error('MCP SDK not available');

    const transportType = this.getTransportType(config);
    let transport: McpTransport | unknown;
    let client: InstanceType<MCPSDKModules['Client']>;

    if (transportType === 'http') {
      if (!config.url) throw new Error('HTTP transport requires a URL');
      const result = await this.connectHTTPWithFallback(config, sdk);
      transport = result.transport;
      client = result.client;
    } else {
      if (!config.command) throw new Error('Stdio transport requires a command');
      const stdio = new StdioProcessTransport(this.deps.process, {
        command: config.command,
        args: config.args ?? [],
        env: config.env ?? {},
      });
      transport = stdio;
      client = new sdk.Client(
        {
          name: this.deps.clientName ?? 'abu-core',
          version: this.deps.clientVersion ?? '0.0.1',
        },
        { capabilities: {} }
      );
      await client.connect(stdio as Parameters<typeof client.connect>[0]);
    }

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
        inputSchema: { type: 'object', properties, required: inputSchema.required },
        execute: async (input) => this.callTool(config.name, tool.name, input),
      };
      tools.set(tool.name, toolDef);
    }

    this.servers.set(config.name, { config, client, transport, tools });
    this.addLog(config.name, 'info', `Connected, discovered ${tools.size} tools`);

    // Hook stdio close → clean up
    if (transport instanceof StdioProcessTransport) {
      transport.onstderr = (line) => this.addLog(config.name, 'warn', line);
      const origOnClose = transport.onclose;
      transport.onclose = () => {
        origOnClose?.();
        this.handleServerDisconnect(config.name);
      };
    }

    this.log.info('MCP server connected', { name: config.name, toolCount: tools.size });
    this.notifyListeners();
  }

  private async connectHTTPWithFallback(
    config: MCPServerConfig,
    sdk: MCPSDKModules
  ): Promise<{
    transport: unknown;
    client: InstanceType<MCPSDKModules['Client']>;
  }> {
    const url = new URL(config.url!);
    const fetchAdapter = this.deps.fetch;
    const fetchFn = (input: string | URL | Request, init?: RequestInit) =>
      fetchAdapter.fetch(typeof input === 'string' ? input : input.toString(), init);

    const transportOpts = {
      fetch: fetchFn as unknown as typeof globalThis.fetch,
      requestInit: config.headers ? { headers: config.headers } : undefined,
    };

    if (sdk.StreamableHTTPClientTransport) {
      try {
        this.addLog(config.name, 'info', 'Trying StreamableHTTP transport...');
        const transport = new sdk.StreamableHTTPClientTransport(url, transportOpts);
        const client = new sdk.Client(
          { name: this.deps.clientName ?? 'abu-core', version: this.deps.clientVersion ?? '0.0.1' },
          { capabilities: {} }
        );
        await client.connect(transport as Parameters<typeof client.connect>[0]);
        this.addLog(config.name, 'info', 'Connected via StreamableHTTP');
        return { transport, client };
      } catch (err) {
        this.addLog(
          config.name,
          'warn',
          `StreamableHTTP failed: ${err instanceof Error ? err.message : String(err)}, trying SSE...`
        );
      }
    }

    if (sdk.SSEClientTransport) {
      this.addLog(config.name, 'info', 'Trying SSE transport...');
      const transport = new sdk.SSEClientTransport(url, transportOpts);
      const client = new sdk.Client(
        { name: this.deps.clientName ?? 'abu-core', version: this.deps.clientVersion ?? '0.0.1' },
        { capabilities: {} }
      );
      await client.connect(transport as Parameters<typeof client.connect>[0]);
      this.addLog(config.name, 'info', 'Connected via SSE');
      return { transport, client };
    }

    throw new Error('No HTTP transport available');
  }

  private handleServerDisconnect(name: string): void {
    const server = this.servers.get(name);
    if (!server) return;
    this.log.warn('MCP server disconnected', { name });
    const transport = server.transport;
    if (transport instanceof StdioProcessTransport) {
      transport.onclose = undefined;
      transport.close().catch(() => {});
    }
    this.servers.delete(name);
    this.notifyListeners();
    this.addLog(name, 'warn', 'Disconnected. Click reconnect to retry.');
  }

  addLog(serverName: string, level: MCPLogEntry['level'], message: string): void {
    let logs = this.serverLogs.get(serverName);
    if (!logs) {
      logs = [];
      this.serverLogs.set(serverName, logs);
    }
    logs.push({ timestamp: this.deps.clock.now(), level, message });
    if (logs.length > MAX_LOG_LINES) {
      logs.splice(0, logs.length - MAX_LOG_LINES);
    }
  }

  getServerLogs(serverName: string): MCPLogEntry[] {
    return this.serverLogs.get(serverName) ?? [];
  }

  clearServerLogs(serverName: string): void {
    this.serverLogs.delete(serverName);
  }

  async disconnectServer(name: string): Promise<void> {
    const server = this.servers.get(name);
    if (!server) return;
    try {
      await server.client.close();
    } catch (err) {
      this.log.error('Error disconnecting', { name, error: String(err) });
    }
    this.servers.delete(name);
    this.notifyListeners();
  }

  async disconnectAll(): Promise<void> {
    const names = Array.from(this.servers.keys());
    await Promise.all(names.map((name) => this.disconnectServer(name)));
  }

  listTools(): ToolDefinition[] {
    const all: ToolDefinition[] = [];
    for (const s of this.servers.values()) all.push(...s.tools.values());
    return all;
  }

  getServerTools(serverName: string): ToolDefinition[] {
    const server = this.servers.get(serverName);
    return server ? Array.from(server.tools.values()) : [];
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<ToolResult> {
    const server = this.servers.get(serverName);
    if (!server) throw new Error(`Server ${serverName} not connected`);

    const toolDef = server.tools.get(toolName);
    const coerced = toolDef ? coerceNumericArgs(toolDef, args) : args;
    const timeoutMs = server.config.timeout ?? DEFAULT_TOOL_TIMEOUT_MS;

    let timerId: ReturnType<ClockAdapter['setTimeout']> | null = null;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timerId = this.deps.clock.setTimeout(
          () => reject(new Error(`MCP tool call timed out after ${timeoutMs / 1000}s: ${toolName}`)),
          timeoutMs
        );
      });
      const result = await Promise.race([
        server.client.callTool({ name: toolName, arguments: coerced }),
        timeoutPromise,
      ]);
      if (timerId !== null) this.deps.clock.clearTimeout(timerId);

      const typed = result as {
        content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
      };
      if (typed.content && Array.isArray(typed.content)) {
        const hasImages = typed.content.some((c) => c.type === 'image' && c.data);
        if (hasImages) {
          return typed.content.map((c) => {
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
            if (c.type === 'text') return { type: 'text' as const, text: c.text ?? '' };
            return { type: 'text' as const, text: JSON.stringify(c) };
          }) as ToolResultContent[];
        }
        return typed.content
          .map((c) => (c.type === 'text' ? c.text : JSON.stringify(c)))
          .join('\n');
      }
      return JSON.stringify(result);
    } catch (err) {
      if (timerId !== null) this.deps.clock.clearTimeout(timerId);
      throw new Error(
        `Tool call failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  getStatus(): MCPServerStatus[] {
    const statuses: MCPServerStatus[] = [];
    for (const [name, server] of this.servers) {
      statuses.push({ name, connected: true, tools: Array.from(server.tools.keys()) });
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
