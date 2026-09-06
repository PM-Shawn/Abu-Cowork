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
/** How many audit rows one block keeps; older ones are dropped. */
export const MAX_AUDIT_ROWS = 50;
/**
 * Longest `ui/open-link` URL the host will even offer to open. A URL is the
 * ONLY channel an app has to move bytes out (`connect-src 'none'` blocks the
 * rest), so an unbounded query string is an unbounded exfiltration pipe, and a
 * URL nobody can read in the confirmation dialog is not really consented to.
 */
export const MAX_APP_LINK_URL_CHARS = 2048;
/** Accepted `ui/update-model-context` calls per block, per rolling minute. */
export const MAX_APP_MODEL_CONTEXT_UPDATES_PER_MINUTE = 20;
/**
 * Trailing-edge coalescing window for the PERSISTED copy of the model context.
 * The in-memory value still updates on every accepted call (the expander is
 * live); only the write-through to conversation storage is throttled, so an app
 * animating a selection cannot turn one step into a write storm.
 */
export const MODEL_CONTEXT_PERSIST_INTERVAL_MS = 1_000;

/** Generic text handed back to the app when a tool execution throws. The real
 *  message can name paths, hosts or credentials from the server's error; the
 *  user still sees it in the audit row, the sandboxed app never does. */
export const APP_TOOL_FAILURE_MESSAGE = 'tool call failed';

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

/**
 * How an audited attempt ended. Present on every `open-link` row and on rows
 * the host refused without ever reaching the server; a plain executed tool call
 * leaves it undefined and is described by `summary` alone. The label is
 * rendered from this field (not from `summary`) so the policy layer stays free
 * of user-facing strings.
 */
export type McpAppAuditOutcome =
  | 'opened'
  | 'declined'
  | 'rate-limited'
  | 'rejected-scheme'
  | 'too-long';

/** One row under the tool card: what the interface asked to do on the user's
 *  behalf, whether or not it was allowed to. */
export interface McpAppAuditEntry {
  id: string;
  kind: 'tool-call' | 'open-link';
  tool: string;
  args: Record<string, unknown>;
  /** Text summary of the result, or the denial reason. */
  summary: string;
  isError: boolean;
  outcome?: McpAppAuditOutcome;
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
  /**
   * Ask the user, then (only on a yes) hand the URL to the shared widget
   * external-link path. Resolves `true` when the link was actually opened.
   *
   * 🔴 An app calls `ui/open-link` on its own initiative — no click needed —
   * and with `connect-src 'none'` the URL is the only way bytes leave the
   * sandbox. So this is a consent gate, not a formality: it MUST show the full
   * URL and MUST NOT open anything before the user agrees. That is a stricter
   * contract than the widget path (where a human clicked an anchor) on purpose.
   */
  requestOpenLink(url: string): Promise<boolean>;
  /** Writes into the composer draft — MUST NOT send. */
  appendComposerDraft(text: string): void;
  /** Updates the in-memory model-visible appendix (overwrite, immediate). */
  setModelContext(text: string): void;
  /** Write-through to storage. Called at most once per
   *  {@link MODEL_CONTEXT_PERSIST_INTERVAL_MS}; last value wins. */
  persistModelContext(text: string): void;
  setDisplayMode(mode: 'inline' | 'fullscreen'): void;
  onAudit(entry: McpAppAuditEntry): void;
  onRateLimited(): void;
  now?(): number;
  /** Injected so audit-row ids are deterministic in tests. */
  nextAuditId?(): string;
  /** Timer seam for the persistence throttle. Returns a cancel function.
   *  Injected so a test can drive it with `vi.useFakeTimers()` (or by hand)
   *  instead of waiting on a real clock. */
  schedule?(fn: () => void, ms: number): () => void;
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

/** Handlers plus the teardown hook the host must call — see `dispose`. */
export type DisposableAppBridgeHandlers = AppBridgeHandlers & {
  /** Cancel the pending persistence timer, flushing the last value first so a
   *  teardown never silently drops what the app last told the model. */
  dispose(): void;
};

export function createAppBridgeHandlers(deps: AppBridgeHandlerDeps): DisposableAppBridgeHandlers {
  const now = deps.now ?? (() => Date.now());
  // ONE budget for every server-visible action the app can start on its own:
  // `tools/call` and `ui/open-link` share it, because both are "the interface
  // acted without the user asking" and letting each have its own 20 would just
  // double the ceiling.
  const limiter = createRateLimiter(MAX_APP_TOOL_CALLS_PER_MINUTE, APP_RATE_LIMIT_WINDOW_MS, now);
  const contextLimiter = createRateLimiter(
    MAX_APP_MODEL_CONTEXT_UPDATES_PER_MINUTE,
    APP_RATE_LIMIT_WINDOW_MS,
    now,
  );
  const schedule = deps.schedule ?? ((fn: () => void, ms: number) => {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  });
  let auditSeq = 0;
  const nextAuditId = deps.nextAuditId ?? (() => `audit-${++auditSeq}`);

  // Trailing-edge throttle for the persisted copy (see the constant's doc).
  let pendingPersist: string | undefined;
  let cancelPersist: (() => void) | undefined;
  const flushPersist = (): void => {
    cancelPersist = undefined;
    if (pendingPersist === undefined) return;
    const text = pendingPersist;
    pendingPersist = undefined;
    deps.persistModelContext(text);
  };
  const schedulePersist = (text: string): void => {
    pendingPersist = text;
    if (cancelPersist) return; // a write is already due; last value wins
    cancelPersist = schedule(flushPersist, MODEL_CONTEXT_PERSIST_INTERVAL_MS);
  };

  const audit = (entry: Omit<McpAppAuditEntry, 'id'>): void => {
    deps.onAudit({ id: nextAuditId(), ...entry });
  };

  return {
    dispose() {
      if (cancelPersist) {
        cancelPersist();
        cancelPersist = undefined;
      }
      flushPersist();
    },

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
        // A throttled call is still something the interface tried to do on the
        // user's behalf — it gets a row like every other attempt.
        audit({ kind: 'tool-call', tool: toolName, args, summary: '', isError: true, outcome: 'rate-limited' });
        throw new AppBridgeRpcError(
          RATE_LIMITED,
          `The app exceeded ${MAX_APP_TOOL_CALLS_PER_MINUTE} tool calls per minute`,
        );
      }

      const namespaced = `${deps.server}__${toolName}`;
      const approval = await deps.checkApproval(namespaced, args);
      if (approval.decision !== 'allow') {
        const reason = approval.reason ?? `Tool ${toolName} was denied`;
        audit({ kind: 'tool-call', tool: toolName, args, summary: reason, isError: true });
        throw new AppBridgeRpcError(DENIED, reason);
      }

      try {
        const result = await deps.callTool(toolName, args);
        audit({
          kind: 'tool-call',
          tool: toolName,
          args,
          summary: summarize(result),
          isError: result.isError === true,
        });
        return result;
      } catch (error) {
        // The user sees the real failure in the audit row; the app gets a
        // generic string. A server's error text routinely carries absolute
        // paths, internal hostnames or token fragments, and handing that to a
        // sandboxed page would leak exactly what the sandbox exists to contain.
        const message = error instanceof Error ? error.message : String(error);
        audit({ kind: 'tool-call', tool: toolName, args, summary: message, isError: true });
        throw new AppBridgeRpcError(DENIED, APP_TOOL_FAILURE_MESSAGE);
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

    /**
     * 🔴 The one outbound channel. A widget link needs a human click; an app can
     * call this from a timer with a URL it built out of anything it has read, so
     * the host asks EVERY time, shares the per-minute budget with `tools/call`,
     * bounds the URL, and leaves an audit row whatever the answer was.
     */
    async onopenlink(params) {
      const url = params?.url;
      const args = { url } as Record<string, unknown>;
      const refuse = (
        outcome: McpAppAuditOutcome,
        code: number,
        message: string,
      ): never => {
        audit({ kind: 'open-link', tool: 'ui/open-link', args, summary: message, isError: true, outcome });
        throw new AppBridgeRpcError(code, message);
      };

      if (typeof url !== 'string') {
        throw new AppBridgeRpcError(INVALID_PARAMS, 'ui/open-link requires a url');
      }
      if (url.length > MAX_APP_LINK_URL_CHARS) {
        return refuse(
          'too-long',
          INVALID_PARAMS,
          `URL exceeds ${MAX_APP_LINK_URL_CHARS} characters`,
        );
      }
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return refuse('rejected-scheme', INVALID_PARAMS, `Not a valid URL: ${url}`);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return refuse(
          'rejected-scheme',
          DENIED,
          `Only http and https links can be opened (got ${parsed.protocol})`,
        );
      }
      if (!limiter.tryConsume()) {
        deps.onRateLimited();
        return refuse(
          'rate-limited',
          RATE_LIMITED,
          `The app exceeded ${MAX_APP_TOOL_CALLS_PER_MINUTE} tool calls per minute`,
        );
      }

      const opened = await deps.requestOpenLink(url);
      if (!opened) {
        return refuse('declined', DENIED, 'user declined');
      }
      audit({ kind: 'open-link', tool: 'ui/open-link', args, summary: url, isError: false, outcome: 'opened' });
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
      if (!contextLimiter.tryConsume()) {
        throw new AppBridgeRpcError(
          RATE_LIMITED,
          `The app exceeded ${MAX_APP_MODEL_CONTEXT_UPDATES_PER_MINUTE} model-context updates per minute`,
        );
      }
      const text = textFromContentBlocks(params?.content);
      // Overwrite, never append: the spec says each update replaces the last.
      const clamped = truncateToBytes(text, MAX_APP_MODEL_CONTEXT_BYTES);
      // Live value is immediate (the expander must not lag); the write-through
      // is coalesced so a busy app cannot storm conversation storage.
      deps.setModelContext(clamped);
      schedulePersist(clamped);
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
