// MCP Client Manager
// Stdio transport uses Tauri Rust backend for child process management.
// HTTP transports (StreamableHTTP, SSE) use the MCP SDK directly.

import type { ToolDefinition, ToolParameter, ToolResult, ToolResultContent } from '../../types';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { expandConfigEnvVars } from '@/utils/envExpansion';
import { getTauriFetch } from '@/core/llm/tauriFetch';
import { createLogger } from '@/core/logging/logger';

const mcpLogger = createLogger('mcp');

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
let mcpAvailable = false;

async function loadMCPSDK(): Promise<boolean> {
  if (mcpAvailable) return true;

  const [clientResult, streamableResult, sseResult] = await Promise.allSettled([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    import('@modelcontextprotocol/sdk/client/sse.js'),
  ]);

  // Core Client — required
  if (clientResult.status === 'fulfilled') {
    Client = clientResult.value.Client;
    console.log('[MCP] Client loaded');
  } else {
    console.log('[MCP] Client not available:', clientResult.reason);
    return false;
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

export class MCPClientManager {
  private servers: Map<string, ConnectedServer> = new Map();
  private listeners: Set<() => void> = new Set();
  private reconnectAttempts: Map<string, number> = new Map();
  private reconnectTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private serverLogs: Map<string, MCPLogEntry[]> = new Map();

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
        // Pre-check: if command is npx/node, verify Node.js is installed
        const cmd = expandedConfig.command;
        if (cmd === 'npx' || cmd === 'node' || cmd === 'npm') {
          try {
            await invoke('run_shell_command', { command: 'node --version', cwd: null, background: false, timeout: 5 });
          } catch {
            throw new Error(
              `未检测到 Node.js 环境。${cmd} 命令需要先安装 Node.js。\n请访问 https://nodejs.org 下载安装后重试。`
            );
          }
        }
        transport = new TauriStdioTransport({
          command: expandedConfig.command,
          args: expandedConfig.args ?? [],
          env: expandedConfig.env ?? {},
        });

        // Create MCP client and connect for stdio
        client = new Client(
          { name: 'abu-desktop', version: '0.1.0' },
          { capabilities: {} }
        );
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

        // Pass through the full JSON Schema for each property
        // to preserve items, default, properties, etc.
        const properties: Record<string, ToolParameter> = {};
        if (inputSchema.properties) {
          for (const [key, prop] of Object.entries(inputSchema.properties)) {
            properties[key] = {
              ...prop,
              type: (prop.type as string) || 'string',
              description: (prop.description as string) ?? '',
            } as ToolParameter;
          }
        }

        const toolDef: ToolDefinition = {
          name: `${config.name}__${tool.name}`,
          description: tool.description ?? '',
          inputSchema: {
            type: 'object',
            properties,
            required: inputSchema.required,
          },
          execute: async (input) => {
            return this.callTool(config.name, tool.name, input);
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

    // Try StreamableHTTP first
    if (StreamableHTTPClientTransport) {
      try {
        this.addLog(displayName, 'info', 'Trying StreamableHTTP transport...');
        const transport = new StreamableHTTPClientTransport(url, transportOpts);
        const client = new Client(
          { name: 'abu-desktop', version: '0.1.0' },
          { capabilities: {} }
        );
        await client.connect(transport as Parameters<typeof client.connect>[0]);
        this.addLog(displayName, 'info', 'Connected via StreamableHTTP');
        return { transport, client };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.addLog(displayName, 'warn', `StreamableHTTP failed: ${msg}, trying SSE...`);
      }
    }

    // Fallback to SSE
    if (SSEClientTransport) {
      this.addLog(displayName, 'info', 'Trying SSE transport...');
      const transport = new SSEClientTransport(url, transportOpts);
      const client = new Client(
        { name: 'abu-desktop', version: '0.1.0' },
        { capabilities: {} }
      );
      await client.connect(transport as Parameters<typeof client.connect>[0]);
      this.addLog(displayName, 'info', 'Connected via SSE');
      return { transport, client };
    }

    throw new Error('No HTTP transport available (neither StreamableHTTP nor SSE)');
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
    this.notifyListeners();
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
    for (const server of this.servers.values()) {
      allTools.push(...server.tools.values());
    }
    return allTools;
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
    if (!server) {
      throw new Error(`Server ${serverName} not connected`);
    }

    let timerId: ReturnType<typeof setTimeout>;
    try {
      const client = server.client as {
        callTool: (params: { name: string; arguments: Record<string, unknown> }) => Promise<{
          content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
        }>;
      };
      // Browser automation tools need longer timeouts (waiting for popups, page loads, etc.)
      const defaultTimeout = serverName === 'abu-browser-bridge' ? 120000 : 30000;
      const serverTimeout = server.config.timeout ?? defaultTimeout;
      const timeout = new Promise<never>((_, reject) => {
        timerId = setTimeout(() => reject(new Error(`MCP tool call timed out after ${serverTimeout / 1000}s: ${toolName}`)), serverTimeout);
      });
      const result = await Promise.race([
        client.callTool({ name: toolName, arguments: args }),
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
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[MCP] Tool call failed: ${serverName}:${toolName}`, err);
      throw new Error(`Tool call failed: ${errorMsg}`);
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
