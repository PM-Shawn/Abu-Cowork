import type {
  Message,
  ToolDefinition,
  BuiltinSearchMethod,
} from '../../../../src/types';
import type { StreamEvent } from '../../../../src/types';
import type { PromptSection } from './promptSections';

export type ToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'tool'; name: string };

export interface ChatOptions {
  model: string;
  apiKey: string;
  baseUrl?: string;
  systemPrompt?: string;
  systemPromptSections?: PromptSection[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  toolChoice?: ToolChoice;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  metadata?: { userId?: string };
  enableThinking?: boolean;
  thinkingBudget?: number;
  supportsVision?: boolean;
  builtinWebSearch?: BuiltinSearchMethod;
  signal?: AbortSignal;
}

export interface LLMAdapter {
  chat(
    messages: Message[],
    options: ChatOptions,
    onEvent: (event: StreamEvent) => void
  ): Promise<void>;
}

export type LLMErrorCode =
  | 'rate_limit'
  | 'overloaded'
  | 'context_too_long'
  | 'invalid_request'
  | 'authentication'
  | 'not_found'
  | 'server_error'
  | 'network_error'
  | 'cancelled'
  | 'unknown';

export class LLMError extends Error {
  code: LLMErrorCode;
  retryable: boolean;
  retryAfterMs?: number;
  statusCode?: number;

  constructor(
    message: string,
    code: LLMErrorCode,
    options?: { retryable?: boolean; retryAfterMs?: number; statusCode?: number }
  ) {
    super(message);
    this.name = 'LLMError';
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.retryAfterMs = options?.retryAfterMs;
    this.statusCode = options?.statusCode;
  }
}

export function classifyError(statusCode: number, message: string): LLMError {
  if (statusCode === 429) {
    const retryAfter = extractRetryAfter(message);
    return new LLMError(message, 'rate_limit', {
      retryable: true,
      retryAfterMs: retryAfter,
      statusCode,
    });
  }
  if (statusCode === 529 || statusCode === 503) {
    return new LLMError(message, 'overloaded', {
      retryable: true,
      retryAfterMs: 5000,
      statusCode,
    });
  }
  if (statusCode === 500 || statusCode === 502) {
    return new LLMError(message, 'server_error', {
      retryable: true,
      retryAfterMs: 2000,
      statusCode,
    });
  }
  if (statusCode === 401 || statusCode === 403) {
    return new LLMError(message, 'authentication', { retryable: false, statusCode });
  }
  if (statusCode === 404) {
    return new LLMError(message, 'not_found', { retryable: false, statusCode });
  }
  if (statusCode === 400) {
    const isContextTooLong =
      /prompt.is.too.long|token.*exceed|too.many.tokens|max.tokens.exceeded|context.window|context.length/i.test(
        message
      );
    if (isContextTooLong) {
      return new LLMError(message, 'context_too_long', { retryable: false, statusCode });
    }
    return new LLMError(message, 'invalid_request', { retryable: false, statusCode });
  }
  return new LLMError(message, 'unknown', { retryable: false, statusCode });
}

function extractRetryAfter(message: string): number | undefined {
  const match = message.match(/retry.after[:\s]*(\d+)/i);
  if (match) return parseInt(match[1], 10) * 1000;
  return undefined;
}
