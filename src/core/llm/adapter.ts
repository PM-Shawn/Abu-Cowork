import type { StreamEvent, Message, ToolDefinition, BuiltinSearchMethod } from '../../types';
import type { PromptSection } from './promptSections';

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
 * Classify an HTTP status code and error message into an LLMError.
 * Accepts raw response body — will extract a clean message from JSON if possible.
 */
export function classifyError(statusCode: number, rawBody: string): LLMError {
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

