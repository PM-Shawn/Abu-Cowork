import { describe, it, expect } from 'vitest';
import { classifyError, LLMError, formatLlmDisplayError } from './adapter';

describe('adapter', () => {
  // ── LLMError class ──
  describe('LLMError', () => {
    it('creates error with code and message', () => {
      const err = new LLMError('Rate limited', 'rate_limit');
      expect(err.message).toBe('Rate limited');
      expect(err.code).toBe('rate_limit');
      expect(err.name).toBe('LLMError');
      expect(err.retryable).toBe(false); // default
    });

    it('creates retryable error with options', () => {
      const err = new LLMError('Overloaded', 'overloaded', {
        retryable: true,
        retryAfterMs: 5000,
        statusCode: 529,
      });
      expect(err.retryable).toBe(true);
      expect(err.retryAfterMs).toBe(5000);
      expect(err.statusCode).toBe(529);
    });

    it('is instanceof Error', () => {
      const err = new LLMError('test', 'unknown');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(LLMError);
    });
  });

  // ── classifyError — HTTP status codes ──
  describe('classifyError', () => {
    it('429 → rate_limit (retryable)', () => {
      const err = classifyError(429, 'Too many requests');
      expect(err.code).toBe('rate_limit');
      expect(err.retryable).toBe(true);
      expect(err.statusCode).toBe(429);
    });

    it('429 with retry-after header', () => {
      const err = classifyError(429, 'Rate limit, retry after: 30 seconds');
      expect(err.code).toBe('rate_limit');
      expect(err.retryAfterMs).toBe(30000);
    });

    it('529 → overloaded (retryable)', () => {
      const err = classifyError(529, 'Service overloaded');
      expect(err.code).toBe('overloaded');
      expect(err.retryable).toBe(true);
      expect(err.retryAfterMs).toBe(5000);
    });

    it('503 → overloaded (retryable)', () => {
      const err = classifyError(503, 'Service unavailable');
      expect(err.code).toBe('overloaded');
      expect(err.retryable).toBe(true);
    });

    it('500 → server_error (retryable)', () => {
      const err = classifyError(500, 'Internal server error');
      expect(err.code).toBe('server_error');
      expect(err.retryable).toBe(true);
      expect(err.retryAfterMs).toBe(2000);
    });

    it('502 → server_error (retryable)', () => {
      const err = classifyError(502, 'Bad gateway');
      expect(err.code).toBe('server_error');
      expect(err.retryable).toBe(true);
    });

    it('401 → authentication (not retryable)', () => {
      const err = classifyError(401, 'Unauthorized');
      expect(err.code).toBe('authentication');
      expect(err.retryable).toBe(false);
    });

    it('403 → authentication (not retryable)', () => {
      const err = classifyError(403, 'Forbidden');
      expect(err.code).toBe('authentication');
      expect(err.retryable).toBe(false);
    });

    it('404 → not_found (not retryable)', () => {
      const err = classifyError(404, 'Model not found');
      expect(err.code).toBe('not_found');
      expect(err.retryable).toBe(false);
    });

    it('400 with context length → context_too_long', () => {
      const err = classifyError(400, 'prompt is too long for the context window');
      expect(err.code).toBe('context_too_long');
      expect(err.retryable).toBe(false);
    });

    it('400 with token mention → context_too_long', () => {
      const err = classifyError(400, 'max tokens exceeded');
      expect(err.code).toBe('context_too_long');
    });

    it('400 with schema context word → invalid_request (not misclassified)', () => {
      const err = classifyError(400, "Invalid schema for function: In context=('properties', 'paths'), array schema missing items");
      expect(err.code).toBe('invalid_request');
    });

    it('400 generic → invalid_request', () => {
      const err = classifyError(400, 'Invalid parameter value');
      expect(err.code).toBe('invalid_request');
      expect(err.retryable).toBe(false);
    });

    it('unknown status → unknown', () => {
      const err = classifyError(418, "I'm a teapot");
      expect(err.code).toBe('unknown');
      expect(err.retryable).toBe(false);
    });

    it('<!doctype html> body → network_blocked regardless of status', () => {
      const html = '<!doctype html><html><body>网站防火墙</body></html>';
      const err = classifyError(200, html);
      expect(err.code).toBe('network_blocked');
      expect(err.retryable).toBe(false);
    });

    it('<html> body (no doctype) → network_blocked', () => {
      const html = '<html><head><title>Firewall</title></head></html>';
      const err = classifyError(403, html);
      expect(err.code).toBe('network_blocked');
    });

    it('HTML with leading whitespace → network_blocked', () => {
      const html = '  \n<!DOCTYPE HTML><html>blocked</html>';
      const err = classifyError(200, html);
      expect(err.code).toBe('network_blocked');
    });

    it('JSON body starting with < is not misclassified (edge case)', () => {
      // Some providers (edge case) might return JSON — make sure plain JSON isn't hit
      const json = '{"error":{"message":"bad request"}}';
      const err = classifyError(400, json);
      expect(err.code).toBe('invalid_request');
    });
  });

  // ── formatLlmDisplayError ──
  describe('formatLlmDisplayError', () => {
    const emptyBodyFallback = 'The request failed, but the service returned no error details.';

    it('returns the fallback message as-is when non-empty', () => {
      const err = new LLMError('Boom', 'unknown', { statusCode: 500 });
      const result = formatLlmDisplayError(err, 'Boom', emptyBodyFallback);
      expect(result).toBe('Boom');
    });

    it('empty message + LLMError with statusCode/code → "HTTP {status} · {code}"', () => {
      const err = new LLMError('', 'not_found', { statusCode: 404, rawBody: '' });
      const result = formatLlmDisplayError(err, '', emptyBodyFallback);
      expect(result).toBe('HTTP 404 · not_found');
    });

    it('does NOT append a rawBody snippet (classifyError already surfaces non-empty bodies as the message)', () => {
      // A non-empty rawBody would already have become err.message via
      // extractApiErrorMessage, so the fallback path only runs for empty bodies.
      // We must never leak an opaque body (e.g. a WAF page) into the chat surface.
      const err = new LLMError('', 'not_found', { statusCode: 404, rawBody: '<html>blocked by proxy</html>' });
      const result = formatLlmDisplayError(err, '', emptyBodyFallback);
      expect(result).toBe('HTTP 404 · not_found');
      expect(result).not.toContain('html');
    });

    it('non-LLMError + empty message → emptyBodyFallback string', () => {
      const result = formatLlmDisplayError(new Error(''), '', emptyBodyFallback);
      expect(result).toBe(emptyBodyFallback);
    });

    it('LLMError with no statusCode and no rawBody → falls back to just the code', () => {
      // `code` is a required, always-non-empty LLMError field, so the
      // emptyBodyFallback string only surfaces for non-LLMError errors (see
      // the non-LLMError case above) — an LLMError always has at least `code`.
      const err = new LLMError('', 'unknown');
      const result = formatLlmDisplayError(err, '', emptyBodyFallback);
      expect(result).toBe('unknown');
    });
  });

  // ── Retry-after extraction ──
  describe('retry-after extraction', () => {
    it('extracts retry-after seconds from message', () => {
      const err = classifyError(429, 'Rate limit exceeded. Retry after: 10');
      expect(err.retryAfterMs).toBe(10000); // 10s * 1000
    });

    it('returns undefined when no retry-after', () => {
      const err = classifyError(429, 'Rate limit exceeded');
      expect(err.retryAfterMs).toBeUndefined();
    });
  });
});
