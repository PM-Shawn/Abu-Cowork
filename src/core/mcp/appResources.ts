// MCP Apps (extension `io.modelcontextprotocol/ui`, version 2026-01-26) —
// tool `_meta.ui` parsing plus the cache behind `MCPClientManager.readResource`.
//
// Kept out of client.ts so the cache/limit rules (spec §4.1 / §4.5) stay
// unit-testable on their own and client.ts keeps to transport + tool plumbing.

/** Hard ceiling for a single `ui://` resource (UTF-8 bytes). */
export const MAX_APP_RESOURCE_BYTES = 2 * 1024 * 1024;

/** The only URI scheme an MCP App interface resource may use. */
export const APP_RESOURCE_URI_PREFIX = 'ui://';

export type McpAppToolVisibility = 'model' | 'app';

/** `_meta.ui` as kept on a ToolDefinition after validation. */
export interface McpAppToolUi {
  resourceUri: string;
  visibility: ReadonlyArray<McpAppToolVisibility>;
}

/** A resolved `ui://` resource. `isMcpApp` gates the sandboxed renderer. */
export interface McpAppResource {
  mimeType: string;
  text: string;
  isMcpApp: boolean;
}

export type McpAppResourceErrorCode =
  | 'server-not-connected'
  | 'server-not-authorized'
  | 'unsupported-uri'
  | 'no-text-content'
  | 'resource-too-large';

/**
 * Typed rejection from `readResource`. `code` lets the renderer distinguish
 * "server is gone, offer reconnect" from "this resource is not renderable".
 */
export class McpAppResourceError extends Error {
  readonly code: McpAppResourceErrorCode;

  constructor(code: McpAppResourceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'McpAppResourceError';
    this.code = code;
  }
}

const DEFAULT_VISIBILITY: ReadonlyArray<McpAppToolVisibility> = ['model', 'app'];
const KNOWN_VISIBILITY: ReadonlyArray<string> = DEFAULT_VISIBILITY;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** True for a `ui://` interface resource URI. */
export function isAppResourceUri(uri: string): boolean {
  return uri.startsWith(APP_RESOURCE_URI_PREFIX);
}

/**
 * Read `_meta.ui` off an MCP tool descriptor.
 *
 * Returns `undefined` (tool has no interface) for anything that isn't a
 * `{ resourceUri: 'ui://…' }` shape — a malformed declaration is ignored, never
 * an error, so one bad tool can't fail a whole connector's discovery.
 * `visibility` is filtered to the two known values and falls back to
 * `['model','app']` when absent, empty or malformed.
 */
export function parseToolUiMetadata(meta: unknown): McpAppToolUi | undefined {
  if (!isRecord(meta)) return undefined;
  const ui = meta.ui;
  if (!isRecord(ui)) return undefined;

  const resourceUri = ui.resourceUri;
  if (typeof resourceUri !== 'string' || !isAppResourceUri(resourceUri)) return undefined;

  const declared = ui.visibility;
  const filtered = Array.isArray(declared)
    ? declared.filter((v): v is McpAppToolVisibility => typeof v === 'string' && KNOWN_VISIBILITY.includes(v))
    : [];

  return {
    resourceUri,
    visibility: filtered.length > 0 ? filtered : [...DEFAULT_VISIBILITY],
  };
}

/** A tool the model must not see: declared interface, no `model` visibility. */
export function isAppOnlyTool(ui: McpAppToolUi | undefined): boolean {
  return ui !== undefined && !ui.visibility.includes('model');
}

/** `text/html;profile=mcp-app` (parameter order / spacing insensitive). */
export function isMcpAppMimeType(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase().replace(/\s+/g, '');
  return normalized.startsWith('text/html') && normalized.includes('profile=mcp-app');
}

/** UTF-8 byte length of a string (the size the ceiling is expressed in). */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Per-server `ui://` resource cache.
 *
 * Stores the in-flight promise, so concurrent callers for the same
 * server+uri share one SDK round trip and a resolved read is served from
 * memory afterwards. Failures are evicted so a transient error isn't sticky.
 * Nesting by server name (instead of a joined string key) keeps
 * `invalidateServer` exact even for server names containing separators.
 */
export class McpAppResourceCache {
  private byServer: Map<string, Map<string, Promise<McpAppResource>>> = new Map();

  read(serverName: string, uri: string, loader: () => Promise<McpAppResource>): Promise<McpAppResource> {
    const cached = this.byServer.get(serverName)?.get(uri);
    if (cached) return cached;

    const pending: Promise<McpAppResource> = loader().catch((err: unknown) => {
      // Only evict our own entry — an invalidation (or a later read) may have
      // replaced it while this request was in flight.
      const current = this.byServer.get(serverName);
      if (current?.get(uri) === pending) {
        current.delete(uri);
        if (current.size === 0) this.byServer.delete(serverName);
      }
      throw err;
    });

    let perServer = this.byServer.get(serverName);
    if (!perServer) {
      perServer = new Map();
      this.byServer.set(serverName, perServer);
    }
    perServer.set(uri, pending);
    return pending;
  }

  /** Drop everything cached for one server (disconnect / list_changed). */
  invalidateServer(serverName: string): void {
    this.byServer.delete(serverName);
  }

  clear(): void {
    this.byServer.clear();
  }
}
