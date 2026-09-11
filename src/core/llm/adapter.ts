import type { StreamEvent, Message, ToolDefinition, BuiltinSearchMethod, UpstreamErrorDetails } from '../../types';
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
  /**
   * Per-turn volatile context (todos, relevant memories, compression hint),
   * appended by the adapter as an EPHEMERAL user message AFTER the whole
   * conversation history — and, on Anthropic, after the history cache
   * breakpoint. Keeping these bytes out of the system prompt (which precedes
   * the history in every provider's serialization) is what lets the stored
   * history stay prefix-cached across turns; only this small tail is
   * re-billed. Never persisted to conversation history.
   */
  volatileContextTail?: string;
  tools?: ToolDefinition[];
  maxTokens?: number;
  // New parameters for enhanced control
  toolChoice?: ToolChoice;
  temperature?: number;        // 0-1, controls randomness
  topP?: number;               // 0-1, nucleus sampling
  stopSequences?: string[];    // Custom stop sequences
  metadata?: {
    userId?: string;           // For tracking/analytics
    /** Conversation id — used as prompt_cache_key on the official OpenAI endpoint. */
    conversationId?: string;
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

/**
 * Which concrete LLMAdapter implementation to instantiate. Shared between
 * the shell (`selectChatAdapter.ts` / `sidecarAdapter.ts`) and the sidecar
 * (`sidecar/src/llmHost.ts`, bundled from this same file) so both sides
 * agree on the JSON-RPC `llm.chat` params' `adapterKind` field without
 * duplicating the union.
 */
export type AdapterKind = 'claude' | 'openai-compatible';

// --- Error Classification ---

export type LLMErrorCode =
  | 'rate_limit'           // 429
  | 'overloaded'           // 529 / 503
  | 'context_too_long'     // 400 with context length error
  | 'invalid_request'      // 400 other
  | 'authentication'       // 401 / credential-related 403
  | 'content_policy'       // 403 rejected by an upstream content-safety policy
  | 'not_found'            // 404
  | 'server_error'         // 500 / 502
  | 'network_error'        // fetch/connection failures
  | 'network_blocked'      // WAF / proxy intercepted the request and returned HTML
  | 'cancelled'            // user abort
  | 'unknown';

const LLM_ERROR_CODES: ReadonlySet<string> = new Set<LLMErrorCode>([
  'rate_limit',
  'overloaded',
  'context_too_long',
  'invalid_request',
  'authentication',
  'content_policy',
  'not_found',
  'server_error',
  'network_error',
  'network_blocked',
  'cancelled',
  'unknown',
]);

export function isLLMErrorCode(value: unknown): value is LLMErrorCode {
  return typeof value === 'string' && LLM_ERROR_CODES.has(value);
}

export class LLMError extends Error {
  code: LLMErrorCode;
  retryable: boolean;
  retryAfterMs?: number;
  statusCode?: number;
  rawBody?: string;
  upstream?: UpstreamErrorDetails;

  constructor(
    message: string,
    code: LLMErrorCode,
    options?: {
      retryable?: boolean;
      retryAfterMs?: number;
      statusCode?: number;
      rawBody?: string;
      upstream?: UpstreamErrorDetails;
    }
  ) {
    super(message);
    this.name = 'LLMError';
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.retryAfterMs = options?.retryAfterMs;
    this.statusCode = options?.statusCode;
    this.rawBody = options?.rawBody;
    this.upstream = normalizeUpstreamErrorDetails(options?.upstream);
  }
}

const UPSTREAM_ERROR_SUMMARY_MAX_CHARS = 500;
const UPSTREAM_ERROR_IDENTIFIER_MAX_CHARS = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripProviderStatusPrefix(body: string): string {
  return body.replace(/^\s*(?:HTTP\s+)?\d{3}(?:\s*:\s*|\s+|(?=[{[<]))/i, '');
}

/**
 * Bound an error string received from an older/untrusted process without ever
 * promoting a raw JSON or HTML provider response into renderer-visible text.
 * Known wrappers are inspected only for classification; safe plain text keeps
 * its original wording for compatibility.
 */
export function sanitizeUntrustedLlmErrorText(value: unknown, fallback: string): string {
  const safeFallback = fallback.trim().slice(0, UPSTREAM_ERROR_SUMMARY_MAX_CHARS) || 'unknown';
  if (typeof value !== 'string') return safeFallback;
  const trimmed = value.trim();
  if (!trimmed) return safeFallback;

  return isUnsafeStructuredLlmErrorText(trimmed)
    ? safeFallback
    : trimmed.slice(0, UPSTREAM_ERROR_SUMMARY_MAX_CHARS);
}

/** True when an error/stack's first payload line is JSON-like or markup. */
export function isUnsafeStructuredLlmErrorText(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  let candidate = trimmed
    .replace(/^sidecar error\s+-?\d+\s*:\s*/i, '')
    .replace(/^(?:[A-Za-z_$][\w$]*Error|Error)\s*:\s*/, '');
  candidate = stripProviderStatusPrefix(candidate).trimStart();
  return candidate.split(/\r?\n/).some((line) => {
    const payload = stripProviderStatusPrefix(
      line.trim().replace(/^(?:[A-Za-z_$][\w$]*Error|Error)\s*:\s*/, ''),
    ).trimStart();
    if (!payload) return false;
    if (payload.startsWith('<')) return true;
    try {
      JSON.parse(payload);
      return true;
    } catch {
      // A truncated/pretty-printed JSON object or array is still a raw
      // provider body even though one line cannot be parsed in isolation.
      return /^[{[]/.test(payload);
    }
  });
}

/** Validate the bounded provider projection before trusting cross-process data. */
export function isUpstreamErrorDetails(value: unknown): value is UpstreamErrorDetails {
  if (!isRecord(value)) return false;
  const allowedKeys = new Set(['status', 'error_type', 'traceId', 'summary']);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
  if (!Number.isInteger(value.status) || (value.status as number) < 100 || (value.status as number) > 599) {
    return false;
  }
  for (const [key, maxChars] of [
    ['error_type', UPSTREAM_ERROR_IDENTIFIER_MAX_CHARS],
    ['traceId', UPSTREAM_ERROR_IDENTIFIER_MAX_CHARS],
    ['summary', UPSTREAM_ERROR_SUMMARY_MAX_CHARS],
  ] as const) {
    const field = value[key];
    if (field === undefined) continue;
    if (typeof field !== 'string' || field.length > maxChars || field.trim().length === 0) return false;
  }
  return true;
}

/** Return a fresh allowlisted projection for store/export boundaries. */
export function normalizeUpstreamErrorDetails(value: unknown): UpstreamErrorDetails | undefined {
  if (!isUpstreamErrorDetails(value)) return undefined;
  const summary = value.summary && !isUnsafeStructuredLlmErrorText(value.summary)
    ? value.summary.trim()
    : undefined;
  return {
    status: value.status,
    ...(value.error_type ? { error_type: value.error_type.trim() } : {}),
    ...(value.traceId ? { traceId: value.traceId.trim() } : {}),
    ...(summary ? { summary } : {}),
  };
}

function parseProviderErrorBody(rawBody: string): Record<string, unknown> | undefined {
  const stripped = stripProviderStatusPrefix(rawBody);
  try {
    const parsed: unknown = JSON.parse(stripped);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parsesAsJson(rawBody: string): boolean {
  const stripped = stripProviderStatusPrefix(rawBody);
  try {
    JSON.parse(stripped);
    return true;
  } catch {
    return false;
  }
}

function providerErrorRecords(rawBody: string): Record<string, unknown>[] {
  const root = parseProviderErrorBody(rawBody);
  if (!root) return [];
  const nestedError = isRecord(root.error) ? root.error : undefined;
  const nestedDetail = isRecord(root.detail) ? root.detail : undefined;
  const errorDetail = nestedError && isRecord(nestedError.detail) ? nestedError.detail : undefined;
  return [nestedError, errorDetail, nestedDetail, root].filter(isRecord);
}

function firstBoundedString(
  records: Record<string, unknown>[],
  keys: readonly string[],
  maxChars: number,
): string | undefined {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (trimmed) return trimmed.slice(0, maxChars);
    }
  }
  return undefined;
}

/** Build the only provider-error projection allowed to cross the terminal wire. */
export function extractUpstreamErrorDetails(
  statusCode: number,
  rawBody: string,
  fallbackMessage: string,
): UpstreamErrorDetails {
  const records = providerErrorRecords(rawBody);
  const errorType = firstBoundedString(records, ['error_type', 'errorType'], UPSTREAM_ERROR_IDENTIFIER_MAX_CHARS);
  const traceId = firstBoundedString(records, ['traceId', 'trace_id'], UPSTREAM_ERROR_IDENTIFIER_MAX_CHARS);
  const structuredSummary = firstBoundedString(records, ['message', 'detail'], UPSTREAM_ERROR_SUMMARY_MAX_CHARS);
  // For a parsed JSON body with no human-readable message/detail, omit the
  // summary instead of copying the whole JSON object into the UI card. Plain
  // text provider bodies still use the bounded fallback.
  const fallbackSummary = records.length === 0 && !parsesAsJson(rawBody)
    ? fallbackMessage.trim().slice(0, UPSTREAM_ERROR_SUMMARY_MAX_CHARS)
    : '';
  return {
    status: statusCode,
    ...(errorType ? { error_type: errorType } : {}),
    ...(traceId ? { traceId } : {}),
    ...(structuredSummary || fallbackSummary
      ? { summary: structuredSummary || fallbackSummary }
      : {}),
  };
}

/**
 * Produce a bounded terminal/store message without ever falling back to the
 * adapter's raw JSON response body. Detailed raw data remains diagnostic-only.
 */
export function formatLlmTerminalError(err: LLMError): string {
  const upstream = normalizeUpstreamErrorDetails(err.upstream);
  const summary = upstream?.summary?.trim();
  if (summary) return summary.slice(0, UPSTREAM_ERROR_SUMMARY_MAX_CHARS);
  const message = err.message.trim();
  // Hand-constructed local errors have no raw provider body and may carry a
  // useful safe message. Classified HTTP errors either have the bounded
  // upstream projection or retain rawBody, so they take the status/code path.
  if (!upstream && !err.rawBody && message) {
    return message.slice(0, UPSTREAM_ERROR_SUMMARY_MAX_CHARS);
  }
  const status = upstream?.status ?? err.statusCode;
  if (status !== undefined) return `HTTP ${status} · ${err.code}`;
  return err.rawBody ? err.code : message ? message.slice(0, UPSTREAM_ERROR_SUMMARY_MAX_CHARS) : err.code;
}

function isContentPolicyRejection(rawBody: string): boolean {
  const records = providerErrorRecords(rawBody);
  const errorType = firstBoundedString(records, ['error_type', 'errorType'], UPSTREAM_ERROR_IDENTIFIER_MAX_CHARS);
  if (errorType && /governance\.|content[_-]safety|content[_-]policy/i.test(errorType)) {
    return true;
  }
  const detail = firstBoundedString(records, ['detail'], UPSTREAM_ERROR_SUMMARY_MAX_CHARS);
  if (detail && /safety[\s_-]*system/i.test(detail)) {
    return true;
  }
  // A valid JSON body has already been inspected structurally above. Do not
  // regex its serialized message strings: quoted user text can contain
  // fragments such as `'error_type':'content_policy'` without being a
  // provider error field.
  if (parsesAsJson(rawBody)) return false;
  // Some providers prefix the JSON with the status code or return a shape we
  // do not otherwise understand. Keep the fallback precise to the error_type
  // field so quoted user input cannot turn an unrelated 403 into this class.
  return /["']error_type["']\s*:\s*["'][^"']*(?:governance\.|content[_-]safety|content[_-]policy)/i.test(rawBody)
    || /["']detail["']\s*:\s*["'][^"']*safety[\s_-]*system/i.test(rawBody);
}

/**
 * Extract a human-readable message from an OpenAI-compatible API error body.
 * Handles {"error":{"message":"...","type":"...","param":"...","code":"..."}}
 * Falls back to the raw body if not parseable.
 */
export function extractApiErrorMessage(rawBody: string): string {
  // Some providers (e.g. mimo) prefix body with status code: "403 {json}"
  const stripped = stripProviderStatusPrefix(rawBody);
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
  let candidate = stripProviderStatusPrefix(body.slice(0, 8192)).trimStart();

  // HTML documents may omit the <html> element, and proxy pages sometimes
  // prepend an XML declaration or one or more comments. Peel off only those
  // document-level prolog nodes, then require a document root rather than
  // treating arbitrary angle-bracket text in a provider message as HTML.
  while (candidate) {
    if (candidate.startsWith('<!--')) {
      const commentEnd = candidate.indexOf('-->');
      if (commentEnd === -1) return false;
      candidate = candidate.slice(commentEnd + 3).trimStart();
      continue;
    }
    if (/^<\?xml\b/i.test(candidate)) {
      const declarationEnd = candidate.indexOf('?>');
      if (declarationEnd === -1) return false;
      candidate = candidate.slice(declarationEnd + 2).trimStart();
      continue;
    }
    break;
  }

  return /^(?:<!doctype\b|<html\b|<head\b|<body\b)/i.test(candidate);
}

/**
 * Classify an HTTP status code and error message into an LLMError.
 * Accepts raw response body — will extract a clean message from JSON if possible.
 */
export function classifyError(statusCode: number, rawBody: string): LLMError {
  // Detect HTML response before any JSON parsing — a WAF / reverse-proxy
  // intercepted the request and returned an error page instead of an API response.
  if (isHtmlBody(rawBody)) {
    const message = '请求被网络防火墙或代理拦截（返回了 HTML 页面而非 API 响应）';
    return new LLMError(
      message,
      'network_blocked',
      {
        retryable: false,
        statusCode,
        rawBody: rawBody.slice(0, 500),
        upstream: extractUpstreamErrorDetails(statusCode, '', message),
      },
    );
  }

  const message = extractApiErrorMessage(rawBody);
  const stored = rawBody.slice(0, 1000);
  const upstream = extractUpstreamErrorDetails(statusCode, rawBody, message);

  // Rate limiting
  if (statusCode === 429) {
    const retryAfter = extractRetryAfter(message);
    return new LLMError(message, 'rate_limit', {
      retryable: true, retryAfterMs: retryAfter, statusCode, rawBody: stored, upstream,
    });
  }

  // Overloaded
  if (statusCode === 529 || statusCode === 503) {
    return new LLMError(message, 'overloaded', {
      retryable: true, retryAfterMs: 5000, statusCode, rawBody: stored, upstream,
    });
  }

  // Server errors (retryable)
  if (statusCode === 500 || statusCode === 502) {
    return new LLMError(message, 'server_error', {
      retryable: true, retryAfterMs: 2000, statusCode, rawBody: stored, upstream,
    });
  }

  // A provider policy rejection is not a credential failure. Check only 403;
  // 401 remains authentication even if an unusual body mentions safety.
  if (statusCode === 403 && isContentPolicyRejection(rawBody)) {
    const policyMessage = upstream.summary ?? `HTTP ${statusCode} · content_policy`;
    return new LLMError(policyMessage, 'content_policy', {
      retryable: false, statusCode, rawBody: stored, upstream,
    });
  }

  // Auth errors (not retryable)
  if (statusCode === 401 || statusCode === 403) {
    return new LLMError(message, 'authentication', {
      retryable: false, statusCode, rawBody: stored, upstream,
    });
  }

  // Not found
  if (statusCode === 404) {
    return new LLMError(message, 'not_found', {
      retryable: false, statusCode, rawBody: stored, upstream,
    });
  }

  // Bad request — check for context length
  if (statusCode === 400) {
    const isContextTooLong = /prompt.is.too.long|token.*exceed|too.many.tokens|max.tokens.exceeded|context.window|context.length/i.test(message);
    if (isContextTooLong) {
      return new LLMError(message, 'context_too_long', {
        retryable: false, statusCode, rawBody: stored, upstream,
      });
    }
    return new LLMError(message, 'invalid_request', {
      retryable: false, statusCode, rawBody: stored, upstream,
    });
  }

  return new LLMError(message, 'unknown', { retryable: false, statusCode, rawBody: stored, upstream });
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
 * For classified LLM errors, always format from the bounded upstream
 * projection. `err.message` can still contain a raw JSON fallback for local
 * diagnostics and must not be copied into the chat surface.
 */
export function formatLlmDisplayError(
  err: unknown,
  fallbackMessage: string,
  emptyBodyFallback: string,
): string {
  if (err instanceof LLMError) {
    return formatLlmTerminalError(err) || emptyBodyFallback;
  }
  const msg = fallbackMessage.trim();
  if (msg) return msg;
  return emptyBodyFallback;
}
