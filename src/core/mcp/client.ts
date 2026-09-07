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
import {
  McpAppResourceCache,
  McpAppResourceError,
  isAppOnlyTool,
  isAppResourceUri,
  isMcpAppMimeType,
  parseToolUiMetadata,
  utf8ByteLength,
  APP_RESOURCE_URI_PREFIX,
  MAX_APP_RESOURCE_BYTES,
  type McpAppResource,
} from './appResources';

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
 * MCP request `_meta` key carrying the ORIGIN the approval gate decided on for
 * this exact call (U5). The host compares it against the tab's actual URL
 * immediately before executing a state-changing action, closing the window
 * between "approved for shop.example.com" and "the page redirected somewhere
 * else". Rides `_meta`, never the tool's input schema — the model must be able
 * to neither read nor forge it. Mirrors `ABU_EXPECTED_ORIGIN_META_KEY` in
 * `abu-browser-bridge/src/tools.ts` (same duplication rationale as above).
 */
const ABU_EXPECTED_ORIGIN_META_KEY = 'abu/expectedOrigin';

/**
 * MCP request `_meta` key marking a call that came from an UNATTENDED run.
 * Present only when true. It is what makes the origin pin fail-closed: without
 * it the host cannot tell "attended, no pin needed" from "unattended and the
 * pin went missing", and would have to choose one of the two wrong answers.
 * Mirrors `ABU_UNATTENDED_META_KEY` in `abu-browser-bridge/src/tools.ts`.
 */
const ABU_UNATTENDED_META_KEY = 'abu/unattended';

/**
 * MCP request `_meta` key asking the browser server's `get_tabs` to include
 * ONE tab's frame tree. The gate's only probe is `get_tabs`, and a
 * frame-targeted action is authorized against the FRAME's origin — so the gate
 * has to be able to ask for the tree of the tab it is judging. Not in the tool
 * schema: a tree costs a browser round trip, and the model must not be able to
 * spend them at will. Mirrors `ABU_FRAMES_FOR_TAB_META_KEY` in
 * `abu-browser-bridge/src/tools.ts`.
 */
const ABU_FRAMES_FOR_TAB_META_KEY = 'abu/framesForTab';

/**
 * MCP request `_meta` key carrying, for a `batch`, the origin the gate
 * approved for each embedded region its steps target. The page-level pin says
 * nothing about a third-party region inside it — that region can navigate on
 * its own without the tab's address changing. An authorization fact, so it
 * rides `_meta` exactly as `expectedOrigin` does. Mirrors
 * `ABU_EXPECTED_FRAME_ORIGINS_META_KEY` in `abu-browser-bridge/src/tools.ts`.
 */
const ABU_EXPECTED_FRAME_ORIGINS_META_KEY = 'abu/expectedFrameOrigins';

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
  /** Tools visible to the model (registered into the agent loop's tool table). */
  tools: Map<string, ToolDefinition>;
  /**
   * MCP Apps tools declared `visibility: ['app']` — deliberately NOT in `tools`,
   * so they never reach the model; only the app bridge may call them.
   */
  appTools: Map<string, ToolDefinition>;
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
// Notification schema for `notifications/resources/list_changed`, loaded lazily
// with the rest of the SDK (keeps zod out of the startup bundle). OPTIONAL: if
// it can't load we simply don't subscribe, and the ui:// cache falls back to
// per-connection invalidation.
let resourceListChangedSchema: unknown = null;
let mcpAvailable = false;

async function loadMCPSDK(): Promise<boolean> {
  if (mcpAvailable) return true;

  const [clientResult, streamableResult, sseResult, cfworkerResult, typesResult] = await Promise.allSettled([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    import('@modelcontextprotocol/sdk/client/sse.js'),
    import('@modelcontextprotocol/sdk/validation/cfworker'),
    import('@modelcontextprotocol/sdk/types.js'),
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

  // resources/list_changed schema — optional (only invalidates the ui:// cache)
  if (typesResult.status === 'fulfilled') {
    resourceListChangedSchema = typesResult.value.ResourceListChangedNotificationSchema ?? null;
  } else {
    console.warn('[MCP] Resource notification schema not available:', typesResult.reason);
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

// ---------------------------------------------------------------------------
// Raw `CallToolResult` stash for MCP App interfaces
// ---------------------------------------------------------------------------

/** Entries kept at once. Small on purpose: this is a hand-off buffer, not a cache. */
const MAX_RAW_APP_RESULTS = 32;
/** Per-entry JSON size ceiling. A bigger result is simply not stashed. */
const MAX_RAW_APP_RESULT_BYTES = 256 * 1024;

/** Raw MCP tool result, before Abu converts it for display/persistence. */
export interface RawCallToolResult {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Deterministic key for a tool call's arguments: object keys sorted at every
 * depth, so `{a:1,b:2}` and `{b:2,a:1}` hash the same. `JSON.stringify`'s own
 * key order is insertion order, which the model and the app can disagree on.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

function rawResultKey(server: string, tool: string, args: Record<string, unknown>): string {
  return `${server}\u0000${tool}\u0000${stableStringify(args ?? {})}`;
}

/**
 * Renderer-side LRU holding the SERVER'S OWN `CallToolResult` for tools that
 * declare an MCP App interface.
 *
 * Why it exists: Abu persists the *converted* tool output (a display string
 * plus optional content blocks), so `structuredContent` and `_meta` — which
 * real MCP Apps read — are gone by the time `McpAppBlock` replays the result to
 * the interface. Stashing the raw object here lets the block hand the app what
 * the server actually said, on the call that just happened.
 *
 * Deliberately NOT persisted: it is per-process and empty after a reload, and
 * the block falls back to the converted content then (documented at its use
 * site). Keeping raw results on disk would duplicate every tool payload.
 */
const rawAppResults = new Map<string, RawCallToolResult>();

function stashRawAppResult(
  server: string,
  tool: string,
  args: Record<string, unknown>,
  result: RawCallToolResult,
): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(result);
  } catch {
    return; // circular / non-serializable — not worth carrying
  }
  if (serialized === undefined || utf8ByteLength(serialized) > MAX_RAW_APP_RESULT_BYTES) return;
  const key = rawResultKey(server, tool, args);
  // Re-insert so the newest entry is always last (Map preserves insertion order).
  rawAppResults.delete(key);
  rawAppResults.set(key, result);
  while (rawAppResults.size > MAX_RAW_APP_RESULTS) {
    const oldest = rawAppResults.keys().next();
    if (oldest.done) break;
    rawAppResults.delete(oldest.value);
  }
}

/** Test-only: drop every stashed raw result. */
export function resetRawAppResults(): void {
  rawAppResults.clear();
}

export class MCPClientManager {
  private servers: Map<string, ConnectedServer> = new Map();
  private listeners: Set<() => void> = new Set();
  private reconnectAttempts: Map<string, number> = new Map();
  private reconnectTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private serverLogs: Map<string, MCPLogEntry[]> = new Map();
  /** Cached `ui://` MCP App resources, keyed by server + uri. */
  private appResources = new McpAppResourceCache();
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
      const appTools = new Map<string, ToolDefinition>();

      for (const tool of toolsResponse.tools) {
        const inputSchema = tool.inputSchema as {
          type: 'object';
          properties?: Record<string, Record<string, unknown>>;
          required?: string[];
        };

        const properties = buildToolProperties(inputSchema);
        const ui = parseToolUiMetadata(tool._meta);

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
          ...(ui ? { ui } : {}),
        };

        // App-only tools stay out of the model's tool table (spec §4.1).
        // `execute` above deliberately takes the model path, so calling an
        // app-only definition that way rejects; the app bridge must call
        // `callTool(server, tool, args, { viaAppBridge: true })` instead.
        if (isAppOnlyTool(ui)) {
          appTools.set(tool.name, toolDef);
        } else {
          tools.set(tool.name, toolDef);
        }
      }

      // A previous connection's ui:// resources may be stale after a reconnect.
      this.appResources.invalidateServer(config.name);
      this.servers.set(config.name, { config, client, transport, tools, appTools });
      this.registerResourceNotifications(config.name, client);

      // Reset reconnect counter on successful connection
      this.reconnectAttempts.delete(config.name);

      this.addLog(
        config.name,
        'info',
        `Connected, discovered ${tools.size} tools${appTools.size > 0 ? ` (+${appTools.size} app-only)` : ''}`
      );

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

      mcpLogger.info('MCP server connected', {
        name: config.name,
        toolCount: tools.size,
        appToolCount: appTools.size,
      });
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
    this.appResources.invalidateServer(name);
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
   *
   * `toolCount` keeps its meaning — the MODEL-visible tools, which is what the
   * user is deciding about when they wire a connector up. App-only tools
   * (`_meta.ui.visibility` without `'model'`) are reported separately as
   * `appToolCount` rather than folded in: a server whose tools are all
   * interface-driven would otherwise test as "0 tools" and read as broken.
   */
  async testConnection(config: MCPServerConfig): Promise<{
    success: boolean;
    toolCount?: number;
    appToolCount?: number;
    error?: string;
  }> {
    const tempName = `__test_${Date.now()}`;
    const tempConfig = { ...config, name: tempName };

    try {
      await this.connectServer(tempConfig);
      const toolCount = this.servers.get(tempName)?.tools.size ?? 0;
      const appToolCount = this.servers.get(tempName)?.appTools.size ?? 0;
      await this.disconnectServer(tempName);
      // Clean up any logs/reconnect state for the temp name
      this.serverLogs.delete(tempName);
      return { success: true, toolCount, appToolCount };
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
    this.appResources.invalidateServer(name);
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
   * Look up an MCP App tool that is hidden from the model
   * (`_meta.ui.visibility` without `'model'`). Model-visible tools stay in
   * `tools` and are NOT duplicated here — the app bridge checks `tools` first,
   * then falls back to this.
   */
  getAppTool(serverName: string, toolName: string): ToolDefinition | undefined {
    if (isEnterpriseServerBlocked(serverName)) return undefined;
    return this.servers.get(serverName)?.appTools.get(toolName);
  }

  /**
   * Read an MCP App interface resource from a connected server.
   *
   * Only `ui://` URIs on that same server are allowed, the payload must be text
   * and must stay under MAX_APP_RESOURCE_BYTES (spec §4.5). Results are cached
   * per server + uri until the server disconnects/reconnects or announces
   * `notifications/resources/list_changed`; concurrent callers for the same
   * resource share a single round trip.
   *
   * `isMcpApp` reports whether the server declared the MCP Apps HTML profile —
   * a non-App resource is still returned, and the renderer decides what to do.
   *
   * @throws {McpAppResourceError} unknown/unauthorized server, non-`ui://` uri,
   *   missing text content, or an oversized resource.
   */
  async readResource(serverName: string, uri: string): Promise<McpAppResource> {
    if (isEnterpriseServerBlocked(serverName)) {
      throw new McpAppResourceError(
        'server-not-authorized',
        `Enterprise MCP server ${serverName} is not authorized by the current live session`
      );
    }
    if (!isAppResourceUri(uri)) {
      throw new McpAppResourceError(
        'unsupported-uri',
        `Only ${APP_RESOURCE_URI_PREFIX} resources can be read as MCP App interfaces (got: ${uri})`
      );
    }
    const server = this.servers.get(serverName);
    if (!server) {
      throw new McpAppResourceError('server-not-connected', `Server ${serverName} not connected`);
    }

    return this.appResources.read(serverName, uri, async () => {
      const client = server.client as {
        readResource: (params: { uri: string }) => Promise<{
          contents?: Array<{
          uri?: string;
          mimeType?: string;
          text?: string;
          blob?: string;
          _meta?: Record<string, unknown>;
        }>;
        }>;
      };
      const result = await client.readResource({ uri });
      // A server may answer with several contents (the interface plus siblings).
      // Prefer the one that actually is the requested uri; only fall back to
      // "first text content" when none of them carries a matching uri.
      const textContents = (result.contents ?? []).filter((c) => typeof c.text === 'string');
      const content = textContents.find((c) => c.uri === uri) ?? textContents[0];
      if (!content || typeof content.text !== 'string') {
        throw new McpAppResourceError(
          'no-text-content',
          `Resource ${uri} on ${serverName} returned no text content`
        );
      }

      const byteLength = utf8ByteLength(content.text);
      if (byteLength > MAX_APP_RESOURCE_BYTES) {
        throw new McpAppResourceError(
          'resource-too-large',
          `Resource ${uri} on ${serverName} is too large: ${byteLength} bytes (limit ${MAX_APP_RESOURCE_BYTES})`
        );
      }

      const mimeType = content.mimeType ?? '';
      // Carry `_meta.ui` through untouched — the renderer builds the sandbox
      // CSP (`connectDomains`/`resourceDomains`) and the border preference from
      // it. Validation happens there, on the security boundary.
      const rawMeta = (content as { _meta?: Record<string, unknown> })._meta;
      const uiMeta = rawMeta && typeof rawMeta.ui === 'object' && rawMeta.ui !== null
        ? (rawMeta.ui as Record<string, unknown>)
        : undefined;
      return {
        mimeType,
        text: content.text,
        isMcpApp: isMcpAppMimeType(mimeType),
        ...(uiMeta ? { meta: uiMeta } : {}),
      };
    });
  }

  /**
   * Subscribe to `notifications/resources/list_changed` so cached ui:// HTML is
   * dropped when the server rebuilds its resources. Best-effort: if the SDK's
   * notification schema didn't load, the cache still clears on disconnect.
   */
  private registerResourceNotifications(serverName: string, client: unknown): void {
    if (!resourceListChangedSchema) return;
    const target = client as {
      setNotificationHandler?: (schema: unknown, handler: (notification: unknown) => void) => void;
    };
    if (typeof target.setNotificationHandler !== 'function') return;
    try {
      target.setNotificationHandler(resourceListChangedSchema, () => {
        this.appResources.invalidateServer(serverName);
      });
    } catch (err) {
      console.warn(`[MCP] Could not subscribe to resources/list_changed for ${serverName}:`, err);
    }
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
      const client = server.client as { listTools: () => Promise<{ tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown>; _meta?: Record<string, unknown> }> }> };
      const toolsResponse = await client.listTools();
      const tools = new Map<string, ToolDefinition>();
      const appTools = new Map<string, ToolDefinition>();

      for (const tool of toolsResponse.tools) {
        const inputSchema = tool.inputSchema as {
          type: 'object';
          properties?: Record<string, Record<string, unknown>>;
          required?: string[];
        };

        const properties = buildToolProperties(inputSchema);
        const ui = parseToolUiMetadata(tool._meta);

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
          ...(ui ? { ui } : {}),
        };

        // App-only tools stay out of the model's tool table (spec §4.1).
        // `execute` above deliberately takes the model path, so calling an
        // app-only definition that way rejects; the app bridge must call
        // `callTool(server, tool, args, { viaAppBridge: true })` instead.
        if (isAppOnlyTool(ui)) {
          appTools.set(tool.name, toolDef);
        } else {
          tools.set(tool.name, toolDef);
        }
      }

      const oldCount = server.tools.size;
      server.tools = tools;
      server.appTools = appTools;

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

  /**
   * Call a tool on a connected server.
   *
   * `options.viaAppBridge` marks the call as coming from the MCP App bridge
   * (the sandboxed interface), which is the ONLY caller allowed to invoke an
   * app-only tool (`_meta.ui.visibility` without `model`). Hiding those tools
   * from the model's tool table is not enough on its own: the model can still
   * emit a `tool_use` for a name it learned from the app's HTML, a README or a
   * replayed session, and dispatch-by-name (registry.ts) would happily run it.
   * So the check is fail-closed here, before any RPC — the model path must NOT
   * pass this option.
   */
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    opts?: {
      /**
       * Marks the call as coming from the MCP App bridge — the ONLY caller
       * allowed to invoke an app-only tool (see this method's doc). The model
       * path must NOT pass it.
       */
      viaAppBridge?: boolean;
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
      /**
       * Browser servers only: the origin the approval gate decided on for this
       * call, and whether the run is unattended. Together they are the
       * execution-time origin pin — see `ABU_EXPECTED_ORIGIN_META_KEY`.
       */
      expectedOrigin?: string;
      unattended?: boolean;
      /**
       * Only meaningful for the browser server's `get_tabs`: include this
       * tab's frame tree in the listing, so the gate can resolve a
       * frame-targeted action's origin without a second probe.
       */
      framesForTabId?: number;
      /**
       * Browser servers' `batch` only: the origin the gate approved for each
       * embedded region the batch's steps target, keyed by frame handle.
       */
      expectedFrameOrigins?: Record<string, string>;
    }
  ): Promise<ToolResult> {
    if (isEnterpriseServerBlocked(serverName)) {
      throw new Error('Enterprise MCP is not authorized by the current live session');
    }
    const server = this.servers.get(serverName);
    if (!server) {
      throw new Error(`Server ${serverName} not connected`);
    }

    const modelToolDef = server.tools.get(toolName);
    const appToolDef = server.appTools.get(toolName);
    if (!modelToolDef && appToolDef && opts?.viaAppBridge !== true) {
      throw new McpAppResourceError(
        'app-only-tool',
        `Tool ${toolName} on ${serverName} is app-only and can only be called through its MCP App interface`
      );
    }

    // Coerce string → number for numeric-typed parameters before sending to MCP server.
    // LLMs occasionally pass large integer IDs (e.g. Chrome tabId) as quoted strings.
    // App-only tools get the same coercion once the bridge check above passed.
    const toolDef = modelToolDef ?? appToolDef;
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
      if (opts?.expectedOrigin) {
        meta[ABU_EXPECTED_ORIGIN_META_KEY] = opts.expectedOrigin;
      }
      // Only when true: an attended call keeps its exact pre-U5 `_meta` shape,
      // and the host reads "absent ⇒ attended ⇒ no pin enforcement".
      if (opts?.unattended === true) {
        meta[ABU_UNATTENDED_META_KEY] = true;
      }
      if (typeof opts?.framesForTabId === 'number' && Number.isFinite(opts.framesForTabId)) {
        meta[ABU_FRAMES_FOR_TAB_META_KEY] = opts.framesForTabId;
      }
      // `!== undefined`, NOT "has keys" (round-3 R3-B). An EMPTY map is a
      // statement the gate makes on purpose — "I judged no region" — and the
      // run reads a region with no pin as `origin-unverifiable` and stops. The
      // length test silently turned that statement back into an absence, and
      // absence makes `runBatch` fall back to the origins it observed for
      // itself, i.e. to policing itself against its own observations. Only a
      // caller that passes nothing keeps the pre-existing `_meta` shape.
      if (opts?.expectedFrameOrigins !== undefined) {
        meta[ABU_EXPECTED_FRAME_ORIGINS_META_KEY] = opts.expectedFrameOrigins;
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

      // Tools with an interface get their RAW result stashed for the app (see
      // `rawAppResults`). Keyed on the arguments as the CALLER passed them —
      // `McpAppBlock` replays the persisted step input, which is exactly that,
      // not the numeric-coerced copy sent on the wire.
      if (toolDef?.ui) {
        stashRawAppResult(serverName, toolName, args, result as RawCallToolResult);
      }

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
   * Hand the MCP App interface the raw `CallToolResult` for a call Abu already
   * made, and forget it (one hand-off per stash).
   *
   * Returns `undefined` after a reload, a cache eviction, an oversized result,
   * or when the arguments differ — every caller must fall back to the converted
   * content.
   */
  takeRawAppResult(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): RawCallToolResult | undefined {
    const key = rawResultKey(serverName, toolName, args ?? {});
    const hit = rawAppResults.get(key);
    if (hit) rawAppResults.delete(key);
    return hit;
  }

  /**
   * Read a NON-`ui://` resource of a connected server for its app interface
   * (spec §4.3 `resources/read`).
   *
   * Separate from `readResource` on purpose: that one is the interface loader
   * and its `ui://`-only check is a security boundary, not a convenience. This
   * one is read-only, UNCACHED (server data can change between reads, and a
   * stale cache would be worse than a round-trip) and capped at the same
   * `MAX_APP_RESOURCE_BYTES` so an interface cannot pull an arbitrarily large
   * payload into the renderer.
   */
  async readServerResource(serverName: string, uri: string): Promise<{
    contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }>;
  }> {
    if (isEnterpriseServerBlocked(serverName)) {
      throw new McpAppResourceError(
        'server-not-authorized',
        `Enterprise MCP server ${serverName} is not authorized by the current live session`
      );
    }
    const server = this.servers.get(serverName);
    if (!server) {
      throw new McpAppResourceError('server-not-connected', `Server ${serverName} not connected`);
    }
    const client = server.client as {
      readResource: (params: { uri: string }) => Promise<{
        contents?: Array<{ uri?: string; mimeType?: string; text?: string; blob?: string }>;
      }>;
    };
    const result = await client.readResource({ uri });
    const contents = (result.contents ?? []).map((c) => ({
      uri: typeof c.uri === 'string' ? c.uri : uri,
      ...(c.mimeType !== undefined ? { mimeType: c.mimeType } : {}),
      ...(typeof c.text === 'string' ? { text: c.text } : {}),
      ...(typeof c.blob === 'string' ? { blob: c.blob } : {}),
    }));
    let total = 0;
    for (const c of contents) {
      total += utf8ByteLength(c.text ?? '') + (c.blob?.length ?? 0);
    }
    if (total > MAX_APP_RESOURCE_BYTES) {
      throw new McpAppResourceError(
        'resource-too-large',
        `Resource ${uri} on ${serverName} exceeds ${MAX_APP_RESOURCE_BYTES} bytes`
      );
    }
    return { contents };
  }

  /** List a connected server's resources for its app interface (read-only). */
  async listServerResources(serverName: string, cursor?: string): Promise<{
    resources: Array<{ uri: string; name?: string; mimeType?: string; description?: string }>;
    nextCursor?: string;
  }> {
    if (isEnterpriseServerBlocked(serverName)) {
      throw new McpAppResourceError(
        'server-not-authorized',
        `Enterprise MCP server ${serverName} is not authorized by the current live session`
      );
    }
    const server = this.servers.get(serverName);
    if (!server) {
      throw new McpAppResourceError('server-not-connected', `Server ${serverName} not connected`);
    }
    const client = server.client as {
      listResources: (params?: { cursor?: string }) => Promise<{
        resources?: Array<{ uri?: string; name?: string; mimeType?: string; description?: string }>;
        nextCursor?: string;
      }>;
    };
    const result = await client.listResources(cursor === undefined ? undefined : { cursor });
    return {
      resources: (result.resources ?? [])
        .filter((r): r is { uri: string } & typeof r => typeof r.uri === 'string')
        .map((r) => ({
          uri: r.uri,
          ...(r.name !== undefined ? { name: r.name } : {}),
          ...(r.mimeType !== undefined ? { mimeType: r.mimeType } : {}),
          ...(r.description !== undefined ? { description: r.description } : {}),
        })),
      ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}),
    };
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
