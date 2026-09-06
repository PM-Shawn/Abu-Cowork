/**
 * MCP App bridge request handlers (spec §4.3) — the policy half, kept pure.
 *
 * `appBridgeSession.ts` owns the transport and stays default-deny; this module
 * decides what an interface is actually allowed to do and returns plain values
 * or throws a typed {@link AppBridgeRpcError} that the SDK's `Protocol` turns
 * into a JSON-RPC error response. Nothing here touches React, the DOM or the
 * MCP SDK at runtime — every effect arrives as an injected dependency, so the
 * whole policy surface (same-server scoping, schema validation, the shared
 * permission gate, the rate limit, the byte caps) is unit-testable without a
 * browser or a server.
 *
 * 🔴 Security notes worth keeping:
 *  - Tools are looked up on THIS app's server only. The app addresses a tool by
 *    bare name; a name that does not resolve on this server is refused rather
 *    than searched for elsewhere.
 *  - The permission decision is NOT made here. `checkApproval` is the exact
 *    `checkToolApproval` chain a model-initiated call of the same namespaced
 *    tool goes through, so an app call and a model call of one tool are
 *    classified identically. A denial becomes a JSON-RPC error; it never
 *    escapes the bridge as a throw the app cannot see.
 *  - Every allowed or denied call is announced through `onAudit` so the tool
 *    card can show what the interface did behind the user's back.
 */
import type {
  CallToolResult,
  ListResourcesResult,
  ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition, ToolParameter } from '@/types';
import { utf8ByteLength } from './appResources';

// ---------------------------------------------------------------------------
// Limits (spec §4.3 / §4.5)
// ---------------------------------------------------------------------------

/** App-initiated `tools/call` budget per block, per rolling minute. */
export const MAX_APP_TOOL_CALLS_PER_MINUTE = 20;
export const APP_RATE_LIMIT_WINDOW_MS = 60_000;
/** `ui/message` text written into the composer draft. */
export const MAX_APP_MESSAGE_BYTES = 4 * 1024;
/** `ui/update-model-context` text persisted on the step. */
export const MAX_APP_MODEL_CONTEXT_BYTES = 8 * 1024;
/** How much of a tool result the audit row keeps as its summary. */
export const MAX_AUDIT_SUMMARY_CHARS = 500;

// JSON-RPC codes. -32000..-32099 is the implementation-defined range.
const INVALID_PARAMS = -32602;
const DENIED = -32000;
const RATE_LIMITED = -32001;

export class AppBridgeRpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
    this.name = 'AppBridgeRpcError';
  }
}

// ---------------------------------------------------------------------------
// Content-block helpers
// ---------------------------------------------------------------------------

interface TextLikeBlock { type?: unknown; text?: unknown }

/** Concatenate the text blocks of an MCP content array; ignore everything else. */
export function textFromContentBlocks(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const b = block as TextLikeBlock;
      return b && b.type === 'text' && typeof b.text === 'string' ? b.text : '';
    })
    .filter((text) => text.length > 0)
    .join('\n');
}

/**
 * Cut `text` so its UTF-8 encoding fits in `maxBytes`, never splitting a code
 * point (`Array.from` iterates by code point, so an astral character is either
 * fully kept or fully dropped).
 */
export function truncateToBytes(text: string, maxBytes: number): string {
  if (utf8ByteLength(text) <= maxBytes) return text;
  let used = 0;
  const out: string[] = [];
  for (const char of Array.from(text)) {
    const size = utf8ByteLength(char);
    if (used + size > maxBytes) break;
    used += size;
    out.push(char);
  }
  return out.join('');
}

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

function matchesDeclaredType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    // `client.ts`'s `coerceNumericArgs` turns a numeric string into a number
    // for BOTH the model path and the app path, so accepting one here keeps
    // the app from being held to a stricter contract than the model.
    case 'number':
    case 'integer':
      return typeof value === 'number'
        || (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value)));
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'null': return value === null;
    default: return true;
  }
}

/**
 * Minimal JSON-Schema check for app-supplied arguments: required keys present,
 * declared scalar types respected.
 *
 * Deliberately NOT a full validator — Abu has no input-schema validator on the
 * model path either (the SDK's validator only covers `outputSchema`), so a
 * heavier check here would reject payloads the same server accepts from the
 * model. Returns the reason a call must be refused, or `undefined` to allow.
 */
export function validateToolArguments(
  schema: ToolDefinition['inputSchema'] | undefined,
  args: Record<string, unknown>,
): string | undefined {
  if (!schema) return undefined;
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (args[key] === undefined) return `missing required argument: ${key}`;
  }
  const props = schema.properties;
  if (!props) return undefined;
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    const declared = (props as Record<string, ToolParameter | undefined>)[key];
    const type = declared?.type;
    if (typeof type !== 'string') continue;
    if (!matchesDeclaredType(value, type)) {
      return `argument "${key}" must be of type ${type}`;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Rate limit
// ---------------------------------------------------------------------------

export interface RateLimiter {
  /** True when this call fits in the budget (and consumes one slot). */
  tryConsume(): boolean;
}

/** Rolling-window counter. `now` is injected so tests never touch the clock. */
export function createRateLimiter(
  limit = MAX_APP_TOOL_CALLS_PER_MINUTE,
  windowMs = APP_RATE_LIMIT_WINDOW_MS,
  now: () => number = () => Date.now(),
): RateLimiter {
  const hits: number[] = [];
  return {
    tryConsume() {
      const t = now();
      while (hits.length > 0 && t - hits[0] >= windowMs) hits.shift();
      if (hits.length >= limit) return false;
      hits.push(t);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Handler wiring
// ---------------------------------------------------------------------------

/** One row under the tool card: what the interface asked its server to do. */
export interface McpAppAuditEntry {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  /** Text summary of the result, or the denial reason. */
  summary: string;
  isError: boolean;
}

export interface AppApprovalDecision {
  decision: 'allow' | 'deny';
  reason?: string;
}

export interface AppBridgeHandlerDeps {
  /** The MCP server that owns both the app resource and every callable tool. */
  server: string;
  /** Same-server lookup: model-visible tools first, then app-only ones. */
  findTool(tool: string): ToolDefinition | undefined;
  /**
   * The SAME approval chain a model-initiated call goes through — pass the
   * NAMESPACED (`server__tool`) name so every classifier keyed on it
   * (plugin/browser/self-extension/enterprise policy) sees what it would see
   * for a model call.
   */
  checkApproval(namespacedTool: string, args: Record<string, unknown>): Promise<AppApprovalDecision>;
  /** Execute — must go through `mcpManager.callTool(..., { viaAppBridge: true })`. */
  callTool(tool: string, args: Record<string, unknown>): Promise<CallToolResult>;
  /** `ui://` interface resources (cached, MCP-App profile). */
  readAppResource(uri: string): Promise<{ mimeType: string; text: string }>;
  /** Any other resource of the same server — read-only, uncached, size-capped. */
  readServerResource(uri: string): Promise<ReadResourceResult>;
  listResources(cursor?: string): Promise<ListResourcesResult>;
  /** Reuses the widget external-link path; must refuse non-http(s) itself too. */
  openLink(url: string): void;
  /** Writes into the composer draft — MUST NOT send. */
  appendComposerDraft(text: string): void;
  /** Persists the step's model-visible appendix (overwrite). */
  setModelContext(text: string): void;
  setDisplayMode(mode: 'inline' | 'fullscreen'): void;
  onAudit(entry: McpAppAuditEntry): void;
  onRateLimited(): void;
  now?(): number;
  /** Injected so audit-row ids are deterministic in tests. */
  nextAuditId?(): string;
}

export interface AppBridgeHandlers {
  oncalltool(params: { name: string; arguments?: Record<string, unknown> }): Promise<CallToolResult>;
  onreadresource(params: { uri: string }): Promise<ReadResourceResult>;
  onlistresources(params?: { cursor?: string }): Promise<ListResourcesResult>;
  onopenlink(params: { url: string }): Promise<{ isError?: boolean }>;
  onmessage(params: { role: 'user'; content: unknown }): Promise<{ isError?: boolean }>;
  onupdatemodelcontext(params: { content?: unknown }): Promise<Record<string, never>>;
  onrequestdisplaymode(params: { mode: string }): Promise<{ mode: 'inline' | 'fullscreen' }>;
}

function summarize(result: CallToolResult): string {
  const text = textFromContentBlocks(result.content);
  const body = text.length > 0 ? text : JSON.stringify(result.content ?? []);
  return body.length > MAX_AUDIT_SUMMARY_CHARS
    ? `${body.slice(0, MAX_AUDIT_SUMMARY_CHARS)}…`
    : body;
}

export function createAppBridgeHandlers(deps: AppBridgeHandlerDeps): AppBridgeHandlers {
  const limiter = createRateLimiter(
    MAX_APP_TOOL_CALLS_PER_MINUTE,
    APP_RATE_LIMIT_WINDOW_MS,
    deps.now ?? (() => Date.now()),
  );
  let auditSeq = 0;
  const nextAuditId = deps.nextAuditId ?? (() => `audit-${++auditSeq}`);

  return {
    async oncalltool(params) {
      const toolName = params?.name;
      if (typeof toolName !== 'string' || toolName.length === 0) {
        throw new AppBridgeRpcError(INVALID_PARAMS, 'tools/call requires a tool name');
      }
      // Same-server scoping (spec §4.5). The app names a bare tool; if this
      // server does not have it, refuse — never widen the search.
      const definition = deps.findTool(toolName);
      if (!definition) {
        throw new AppBridgeRpcError(
          INVALID_PARAMS,
          `Tool ${toolName} is not available on ${deps.server}`,
        );
      }

      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const invalid = validateToolArguments(definition.inputSchema, args);
      if (invalid) throw new AppBridgeRpcError(INVALID_PARAMS, invalid);

      if (!limiter.tryConsume()) {
        deps.onRateLimited();
        throw new AppBridgeRpcError(
          RATE_LIMITED,
          `The app exceeded ${MAX_APP_TOOL_CALLS_PER_MINUTE} tool calls per minute`,
        );
      }

      const namespaced = `${deps.server}__${toolName}`;
      const approval = await deps.checkApproval(namespaced, args);
      if (approval.decision !== 'allow') {
        const reason = approval.reason ?? `Tool ${toolName} was denied`;
        deps.onAudit({ id: nextAuditId(), tool: toolName, args, summary: reason, isError: true });
        throw new AppBridgeRpcError(DENIED, reason);
      }

      try {
        const result = await deps.callTool(toolName, args);
        deps.onAudit({
          id: nextAuditId(),
          tool: toolName,
          args,
          summary: summarize(result),
          isError: result.isError === true,
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.onAudit({ id: nextAuditId(), tool: toolName, args, summary: message, isError: true });
        throw new AppBridgeRpcError(DENIED, message);
      }
    },

    async onreadresource(params) {
      const uri = params?.uri;
      if (typeof uri !== 'string' || uri.length === 0) {
        throw new AppBridgeRpcError(INVALID_PARAMS, 'resources/read requires a uri');
      }
      if (uri.startsWith('ui://')) {
        const resource = await deps.readAppResource(uri);
        return { contents: [{ uri, mimeType: resource.mimeType, text: resource.text }] };
      }
      return deps.readServerResource(uri);
    },

    async onlistresources(params) {
      return deps.listResources(params?.cursor);
    },

    async onopenlink(params) {
      const url = params?.url;
      if (typeof url !== 'string') {
        throw new AppBridgeRpcError(INVALID_PARAMS, 'ui/open-link requires a url');
      }
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new AppBridgeRpcError(INVALID_PARAMS, `Not a valid URL: ${url}`);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new AppBridgeRpcError(
          DENIED,
          `Only http and https links can be opened (got ${parsed.protocol})`,
        );
      }
      deps.openLink(url);
      return {};
    },

    async onmessage(params) {
      const text = textFromContentBlocks(params?.content).trim();
      if (text.length === 0) {
        throw new AppBridgeRpcError(INVALID_PARAMS, 'ui/message carried no text content');
      }
      // Draft only — never sends. The human stays in the loop (spec §4.3).
      deps.appendComposerDraft(truncateToBytes(text, MAX_APP_MESSAGE_BYTES));
      return {};
    },

    async onupdatemodelcontext(params) {
      const text = textFromContentBlocks(params?.content);
      // Overwrite, never append: the spec says each update replaces the last.
      deps.setModelContext(truncateToBytes(text, MAX_APP_MODEL_CONTEXT_BYTES));
      return {};
    },

    async onrequestdisplaymode(params) {
      const mode = params?.mode;
      if (mode !== 'inline' && mode !== 'fullscreen') {
        throw new AppBridgeRpcError(
          INVALID_PARAMS,
          `Display mode ${String(mode)} is not supported`,
        );
      }
      deps.setDisplayMode(mode);
      return { mode };
    },
  };
}
