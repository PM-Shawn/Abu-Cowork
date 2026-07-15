import type { StreamEvent, Message, ToolDefinition, BuiltinSearchMethod } from '../../types';
import type { PromptSection } from './promptSections';
import type { Logger } from '../logging/logger';

/**
 * Chars of a failed tool call's raw `arguments` to keep in the on-disk
 * diagnostic log. Generous because disk logs cost no tokens and are never sent
 * to the model — this is where the full context for diagnosing a parse failure
 * lives (the break point is often past the first ~200 chars in complex nested
 * tool calls, e.g. ask_user_question with an unescaped quote deep inside).
 */
export const LOG_TOOL_ARG_PREVIEW = 2000;

/**
 * Chars of the raw `arguments` embedded in the `_parse_error` sentinel carried
 * on the tool INPUT. Kept SMALL on purpose: this blob is persisted in the
 * assistant tool_use and re-sent to the model on every subsequent turn until
 * context compaction, so a large value would recurrently inflate token cost (and
 * write more raw arg fragments into the conversation record). All consumers
 * detect `_parse_error` by KEY only and the value is never used as model
 * instructions, so the short preview loses no behavior — full args for diagnosis
 * live in the disk log (LOG_TOOL_ARG_PREVIEW), not here.
 */
export const PARSE_ERROR_INPUT_PREVIEW = 200;

/**
 * Build the `_parse_error` sentinel for a tool call whose raw `arguments`
 * string failed to JSON.parse, and record the full args to the disk log for
 * diagnosis. Shared by both adapters (Claude + OpenAI-compatible) so the log
 * shape and the (deliberately small) replayed sentinel stay in lockstep.
 */
export function buildToolParseError(
  rawArgs: string,
  ctx: { source: string; tool: string },
  log: Logger,
): { _parse_error: string } {
  log.error('tool args JSON parse failed', {
    source: ctx.source,
    tool: ctx.tool,
    argsLength: rawArgs.length,
    argsPreview: rawArgs.slice(0, LOG_TOOL_ARG_PREVIEW),
  });
  return { _parse_error: `Failed to parse tool input: ${rawArgs.slice(0, PARSE_ERROR_INPUT_PREVIEW)}` };
}

// Tool choice configuration for API requests
export type ToolChoice =
  | { type: 'auto' }           // Let model decide (default)
  | { type: 'any' }            // Force use any tool
  | { type: 'tool'; name: string }; // Force use specific tool

export interface ChatOptions {
  model: string;
  apiKey: string;
  baseUrl?: string;
  systemPrompt?: string;
  /**
   * Structured system prompt sections with cacheability annotations.
   * When provided, Anthropic adapter uses these for per-section cache_control.
   * Other adapters ignore this and use systemPrompt string instead.
   */
  systemPromptSections?: PromptSection[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  // New parameters for enhanced control
  toolChoice?: ToolChoice;
  temperature?: number;        // 0-1, controls randomness
  topP?: number;               // 0-1, nucleus sampling
  stopSequences?: string[];    // Custom stop sequences
  metadata?: {
    userId?: string;           // For tracking/analytics
  };
  // Extended thinking support (Claude Opus 4+)
  enableThinking?: boolean;
  thinkingBudget?: number;     // Max reasoning tokens (Claude budget_tokens / Qwen thinking_budget)
  reasoningEffort?: 'low' | 'medium' | 'high'; // OpenAI o-series / gpt-5 reasoning depth
  // Whether the model supports vision (image inputs)
  supportsVision?: boolean;
  /** 自定义端点用户声明的能力，供适配器 URL 归一化与出参规则引擎读取 */
  declaredCapabilities?: import('@/types/provider').DeclaredCapabilities;
  // Built-in web search method to inject into the request
  builtinWebSearch?: BuiltinSearchMethod;
  // Abort controller for cancellation
  signal?: AbortSignal;
  /**
   * Callback invoked when the adapter reverse-engineers the model's
   * true max_tokens limit from a 400 response (e.g. "max_tokens too
   * large: 32768. This model supports at most 4096..."). agentLoop
   * uses this to persist the discovered limit so future requests
   * don't repeat the failed-roundtrip.
   */
  onMaxTokensLimitDiscovered?: (limit: number) => void;
}

export interface LLMAdapter {
  chat(
    messages: Message[],
    options: ChatOptions,
    onEvent: (event: StreamEvent) => void
  ): Promise<void>;
}

// --- Error Classification ---

export type LLMErrorCode =
  | 'rate_limit'           // 429
  | 'overloaded'           // 529 / 503
  | 'context_too_long'     // 400 with context length error
  | 'invalid_request'      // 400 other
  | 'authentication'       // 401 / 403
  | 'not_found'            // 404
  | 'server_error'         // 500 / 502
  | 'network_error'        // fetch/connection failures
  | 'network_blocked'      // WAF / proxy intercepted the request and returned HTML
  | 'cancelled'            // user abort
  | 'unknown';

export class LLMError extends Error {
  code: LLMErrorCode;
  retryable: boolean;
  retryAfterMs?: number;
  statusCode?: number;
  rawBody?: string;

  constructor(
    message: string,
    code: LLMErrorCode,
    options?: { retryable?: boolean; retryAfterMs?: number; statusCode?: number; rawBody?: string }
  ) {
    super(message);
    this.name = 'LLMError';
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.retryAfterMs = options?.retryAfterMs;
    this.statusCode = options?.statusCode;
    this.rawBody = options?.rawBody;
  }
}

/**
 * Extract a human-readable message from an OpenAI-compatible API error body.
 * Handles {"error":{"message":"...","type":"...","param":"...","code":"..."}}
 * Falls back to the raw body if not parseable.
 */
export function extractApiErrorMessage(rawBody: string): string {
  // Some providers (e.g. mimo) prefix body with status code: "403 {json}"
  const stripped = rawBody.replace(/^\d{3}\s+/, '');
  try {
    const parsed = JSON.parse(stripped) as {
      error?: { message?: string };
      message?: string;
    };
    if (typeof parsed.error?.message === 'string' && parsed.error.message) {
      return parsed.error.message;
    }
    if (typeof parsed.message === 'string' && parsed.message) {
      return parsed.message;
    }
  } catch { /* not JSON */ }
  return stripped || rawBody;
}

/**
 * Returns true when the body looks like an HTML document (WAF / proxy intercept page).
 * Some interceptors send 200 OK with HTML; others send 403/other with HTML.
 * Checking the leading bytes is faster and more reliable than Content-Type alone
 * because some WAFs forge application/json in the Content-Type header.
 */
function isHtmlBody(body: string): boolean {
  const trimmed = body.trimStart().toLowerCase();
  return trimmed.startsWith('<!doctype') || trimmed.startsWith('<html');
}

/**
 * Classify an HTTP status code and error message into an LLMError.
 * Accepts raw response body — will extract a clean message from JSON if possible.
 */
export function classifyError(statusCode: number, rawBody: string): LLMError {
  // Detect HTML response before any JSON parsing — a WAF / reverse-proxy
  // intercepted the request and returned an error page instead of an API response.
  if (isHtmlBody(rawBody)) {
    return new LLMError(
      '请求被网络防火墙或代理拦截（返回了 HTML 页面而非 API 响应）',
      'network_blocked',
      { retryable: false, statusCode, rawBody: rawBody.slice(0, 500) },
    );
  }

  const message = extractApiErrorMessage(rawBody);
  const stored = rawBody.slice(0, 1000);

  // Rate limiting
  if (statusCode === 429) {
    const retryAfter = extractRetryAfter(message);
    return new LLMError(message, 'rate_limit', {
      retryable: true, retryAfterMs: retryAfter, statusCode, rawBody: stored,
    });
  }

  // Overloaded
  if (statusCode === 529 || statusCode === 503) {
    return new LLMError(message, 'overloaded', {
      retryable: true, retryAfterMs: 5000, statusCode, rawBody: stored,
    });
  }

  // Server errors (retryable)
  if (statusCode === 500 || statusCode === 502) {
    return new LLMError(message, 'server_error', {
      retryable: true, retryAfterMs: 2000, statusCode, rawBody: stored,
    });
  }

  // Auth errors (not retryable)
  if (statusCode === 401 || statusCode === 403) {
    return new LLMError(message, 'authentication', {
      retryable: false, statusCode, rawBody: stored,
    });
  }

  // Not found
  if (statusCode === 404) {
    return new LLMError(message, 'not_found', {
      retryable: false, statusCode, rawBody: stored,
    });
  }

  // Bad request — check for context length
  if (statusCode === 400) {
    const isContextTooLong = /prompt.is.too.long|token.*exceed|too.many.tokens|max.tokens.exceeded|context.window|context.length/i.test(message);
    if (isContextTooLong) {
      return new LLMError(message, 'context_too_long', {
        retryable: false, statusCode, rawBody: stored,
      });
    }
    return new LLMError(message, 'invalid_request', {
      retryable: false, statusCode, rawBody: stored,
    });
  }

  return new LLMError(message, 'unknown', { retryable: false, statusCode, rawBody: stored });
}

function extractRetryAfter(message: string): number | undefined {
  const match = message.match(/retry.after[:\s]*(\d+)/i);
  if (match) return parseInt(match[1], 10) * 1000;
  return undefined;
}

/**
 * Build a user-facing error string. When the API returned an empty/opaque body
 * (e.g. a bare 404 from a proxy/plan endpoint), the thrown message is empty —
 * fall back to the classified HTTP status + code so the user and diagnostics see
 * something actionable instead of a blank line.
 *
 * `core/llm` stays i18n-free by convention (no other file in this directory
 * imports the i18n module — localization happens at the call site), so the
 * empty-body fallback string is a caller-supplied parameter rather than an
 * internal `getI18n()` call. Callers should pass `getI18n().chat.errorEmptyBody`.
 *
 * Note: we deliberately do NOT append an `rawBody` snippet. `classifyError`
 * already surfaces any non-empty body through `err.message` (via
 * `extractApiErrorMessage`), so an empty `fallbackMessage` implies an empty body —
 * a snippet would never add signal and would only risk leaking an opaque
 * intercept page into the chat surface.
 */
export function formatLlmDisplayError(
  err: unknown,
  fallbackMessage: string,
  emptyBodyFallback: string,
): string {
  const msg = fallbackMessage.trim();
  if (msg) return msg;
  if (err instanceof LLMError) {
    const parts: string[] = [];
    if (err.statusCode) parts.push(`HTTP ${err.statusCode}`);
    if (err.code) parts.push(err.code);
    return parts.join(' · ') || emptyBodyFallback;
  }
  return emptyBodyFallback;
}

