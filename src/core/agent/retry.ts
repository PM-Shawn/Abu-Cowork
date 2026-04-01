/**
 * Retry with exponential backoff for LLM API calls.
 *
 * Enhanced to match Claude Code patterns:
 * - Per-error-code retry limits: rate_limit(429) gets 5 attempts, others get 3
 * - Prefers API Retry-After header when available
 * - Multiplicative jitter: delay * (0.5 + random) for better spread
 * - AbortSignal-aware sleep (user can cancel during wait)
 */

import { LLMError } from '../llm/adapter';

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
};

/**
 * Get the effective max retries for a specific error code.
 * Rate limiting (429) gets more attempts since it's transient.
 */
function getMaxRetriesForError(error: LLMError, configMax: number): number {
  if (error.code === 'rate_limit') return Math.max(configMax, 5);
  if (error.code === 'overloaded') return Math.min(configMax, 3);
  return configMax;
}

/**
 * Execute a function with exponential backoff retry on retryable errors
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {},
  signal?: AbortSignal,
  onRetry?: (attempt: number, error: LLMError, delayMs: number) => void
): Promise<T> {
  const { maxRetries, baseDelayMs, maxDelayMs } = { ...DEFAULT_CONFIG, ...config };

  let lastError: Error | undefined;
  let attempt = 0;
  let effectiveMaxRetries = maxRetries;

  while (attempt <= effectiveMaxRetries) {
    // Check for cancellation
    if (signal?.aborted) {
      throw new LLMError('Request cancelled', 'cancelled', { retryable: false });
    }

    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Don't retry on non-LLMError or non-retryable errors
      if (!(err instanceof LLMError) || !err.retryable) {
        throw err;
      }

      // Don't retry on user cancellation
      if (err.code === 'cancelled') {
        throw err;
      }

      // Dynamically adjust max retries based on error type
      effectiveMaxRetries = getMaxRetriesForError(err, maxRetries);

      // Don't retry if we've exhausted attempts
      if (attempt >= effectiveMaxRetries) {
        throw err;
      }

      // Calculate delay:
      // 1. Prefer API-provided retryAfterMs (from Retry-After header)
      // 2. Fall back to exponential backoff with multiplicative jitter
      let delay: number;
      if (err.retryAfterMs) {
        // API told us exactly how long to wait — add small jitter to avoid thundering herd
        delay = Math.min(err.retryAfterMs * (0.9 + Math.random() * 0.2), maxDelayMs);
      } else {
        const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
        // Multiplicative jitter: spread between 50%-150% of base delay
        delay = Math.min(exponentialDelay * (0.5 + Math.random()), maxDelayMs);
      }

      // Notify caller about retry
      onRetry?.(attempt + 1, err, delay);

      // Wait before retrying (abort-aware)
      await sleep(delay, signal);
      attempt++;
    }
  }

  throw lastError;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new LLMError('Request cancelled', 'cancelled', { retryable: false }));
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new LLMError('Request cancelled', 'cancelled', { retryable: false }));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
