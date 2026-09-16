import { describe, it, expect } from 'vitest';
import {
  classifyError,
  LLMError,
  formatLlmDisplayError,
  formatLlmTerminalError,
  isUpstreamErrorDetails,
  normalizeUpstreamErrorDetails,
  sanitizeUntrustedLlmErrorText,
} from './adapter';

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

  describe('sanitizeUntrustedLlmErrorText', () => {
    it.each([
      '{"private":"provider body"}',
      'Error: {"private":"provider body"}',
      ' 403 {"private":"provider body"}',
      '403{"private":"provider body"}',
      '403: {"private":"provider body"}',
      'HTTP 403: {"private":"provider body"}',
      'Error: 403 {"private":"truncated"',
      '<html><body>private proxy page</body></html>',
      '403 <!doctype html><title>private proxy page</title>',
      '403:<html><body>private proxy page</body></html>',
      'HTTP 403: <html><body>private proxy page</body></html>',
      'Request failed\n{"private":"provider body on the next line"}',
      'Request failed\n<html><body>proxy page on the next line</body></html>',
    ])('drops structured or markup wire text: %s', (message) => {
      expect(sanitizeUntrustedLlmErrorText(message, 'safe fallback')).toBe('safe fallback');
    });

    it('keeps bounded plain-text compatibility messages', () => {
      expect(sanitizeUntrustedLlmErrorText('rate limited', 'safe fallback')).toBe('rate limited');
    });
  });

  describe('upstream error projection', () => {
    it.each([
      { status: 403, error_type: '   ' },
      { status: 403, traceId: '\n' },
      { status: 403, summary: '   ' },
    ])('rejects whitespace-only optional fields: %j', (details) => {
      expect(isUpstreamErrorDetails(details)).toBe(false);
      expect(normalizeUpstreamErrorDetails(details)).toBeUndefined();
    });

    it('fresh-projects trimmed optional fields', () => {
      expect(normalizeUpstreamErrorDetails({
        status: 403,
        error_type: '  content_policy  ',
        traceId: '  trace-403  ',
        summary: '  provider rejected the request  ',
      })).toEqual({
        status: 403,
        error_type: 'content_policy',
        traceId: 'trace-403',
        summary: 'provider rejected the request',
      });
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

    it('Alibaba governance 403 → content_policy with bounded upstream details', () => {
      const err = classifyError(403, JSON.stringify({
        error: {
          message: 'The request was rejected by the content safety system.',
        },
        error_type: 'governance.alicloud_content_safety_input_rejected',
        traceId: 'e7bfa851aa3de992-local-fixture',
      }));

      expect(err).toMatchObject({
        code: 'content_policy',
        retryable: false,
        statusCode: 403,
        upstream: {
          status: 403,
          error_type: 'governance.alicloud_content_safety_input_rejected',
          traceId: 'e7bfa851aa3de992-local-fixture',
          summary: 'The request was rejected by the content safety system.',
        },
      });
    });

    it.each([
      ['content_safety error type', { error_type: 'provider.content_safety.rejected', message: 'rejected' }],
      ['content_policy error type', { error: { error_type: 'content_policy_violation', message: 'rejected' } }],
      ['safety-system detail', { detail: 'Blocked by the upstream safety system.' }],
    ])('403 with %s → content_policy', (_label, body) => {
      expect(classifyError(403, JSON.stringify(body)).code).toBe('content_policy');
    });

    it('401 remains authentication even when a provider body mentions content safety', () => {
      const err = classifyError(401, JSON.stringify({
        error_type: 'governance.alicloud_content_safety_input_rejected',
      }));
      expect(err.code).toBe('authentication');
      expect(err.retryable).toBe(false);
    });

    it('does not promote an unrelated 403 merely because its message says rejected', () => {
      const err = classifyError(403, JSON.stringify({ error: { message: 'Request rejected.' } }));
      expect(err.code).toBe('authentication');
      expect(err.retryable).toBe(false);
    });

    it.each([
      'The safety system API credential is missing.',
      'The safety system endpoint is forbidden.',
      'User input literally said safety system.',
    ])('does not classify a message-only safety-system phrase as content_policy: %s', (message) => {
      const err = classifyError(403, JSON.stringify({ error: { message } }));

      expect(err.code).toBe('authentication');
      expect(err.retryable).toBe(false);
    });

    it.each([
      "User input: 'error_type':'content_policy'",
      "User input: 'detail':'blocked by safety system'",
    ])('does not regex quoted pseudo-fields inside a valid JSON message: %s', (message) => {
      const err = classifyError(403, JSON.stringify({ message }));

      expect(err.code).toBe('authentication');
      expect(err.retryable).toBe(false);
    });

    it('does not copy a message-less JSON body into the upstream summary', () => {
      const rawBody = JSON.stringify({
        error_type: 'governance.alicloud_content_safety_input_rejected',
        traceId: 'trace-without-message',
        private: 'must not appear in the terminal projection',
      });

      const err = classifyError(403, rawBody);

      expect(err.upstream).toEqual({
        status: 403,
        error_type: 'governance.alicloud_content_safety_input_rejected',
        traceId: 'trace-without-message',
      });
      expect(err.message).toBe('HTTP 403 · content_policy');
      expect(formatLlmTerminalError(err)).toBe('HTTP 403 · content_policy');
      expect(JSON.stringify(err.upstream)).not.toContain('private');
    });

    it('projects a leading-space status-prefixed JSON body without copying the raw object', () => {
      const rawBody = ` 403 ${JSON.stringify({
        error_type: 'governance.alicloud_content_safety_input_rejected',
        traceId: 'trace-leading-space',
        private: 'credential-adjacent provider metadata',
      })}`;

      const err = classifyError(403, rawBody);

      expect(err).toMatchObject({
        code: 'content_policy',
        upstream: {
          status: 403,
          error_type: 'governance.alicloud_content_safety_input_rejected',
          traceId: 'trace-leading-space',
        },
      });
      expect(err.upstream).not.toHaveProperty('summary');
      expect(formatLlmTerminalError(err)).toBe('HTTP 403 · content_policy');
      expect(formatLlmTerminalError(err)).not.toContain('private');
    });

    it.each([
      '403{"error_type":"content_policy","private":"secret"}',
      '403: {"error_type":"content_policy","private":"secret"}',
      'HTTP 403: {"error_type":"content_policy","private":"secret"}',
    ])('normalizes compact status prefixes without exposing JSON: %s', (rawBody) => {
      const err = classifyError(403, rawBody);

      expect(err.code).toBe('content_policy');
      expect(err.upstream).toEqual({ status: 403, error_type: 'content_policy' });
      expect(formatLlmTerminalError(err)).toBe('HTTP 403 · content_policy');
      expect(JSON.stringify(err.upstream)).not.toContain('secret');
    });

    it('formats an unrelated message-less JSON 403 as status/code instead of raw JSON for the terminal', () => {
      const err = classifyError(403, JSON.stringify({ private: 'credential-adjacent provider metadata' }));

      expect(err.code).toBe('authentication');
      expect(formatLlmTerminalError(err)).toBe('HTTP 403 · authentication');
      expect(formatLlmTerminalError(err)).not.toContain('private');
    });

    it.each([
      ['array', JSON.stringify([{ private: 'credential-adjacent provider metadata' }])],
      ['string scalar', JSON.stringify('credential-adjacent provider metadata')],
      ['number scalar', JSON.stringify(403403)],
    ])('does not treat a parsed top-level JSON %s as a plain-text provider summary', (_label, rawBody) => {
      const err = classifyError(403, rawBody);

      expect(err.upstream).toEqual({ status: 403 });
      expect(formatLlmTerminalError(err)).toBe('HTTP 403 · authentication');
      expect(formatLlmTerminalError(err)).not.toContain(rawBody);
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

    it.each([
      '<body>\'error_type\':\'content_policy\'</body>',
      '<!-- proxy --> <html><script>var e={"error_type":"content_policy"}</script></html>',
      '<?xml version="1.0"?><html><body>\'error_type\':\'content_policy\'</body></html>',
      '<!-- first --><!-- second --><body>\'error_type\':\'content_policy\'</body>',
    ])('document-level HTML prologs win over policy-shaped page text: %s', (rawBody) => {
      const err = classifyError(403, rawBody);

      expect(err.code).toBe('network_blocked');
      expect(err.retryable).toBe(false);
      expect(formatLlmTerminalError(err)).not.toContain('content_policy');
    });

    it.each([
      '403 <html><body>proxy denied</body></html>',
      '403 <!doctype html><script>var e={"error_type":"content_policy"}</script>',
      '403:<html><body>private proxy page</body></html>',
      'HTTP 403: <html><body>private proxy page</body></html>',
    ])('status-prefixed HTML stays network_blocked and never becomes a terminal summary', (rawBody) => {
      const err = classifyError(403, rawBody);

      expect(err.code).toBe('network_blocked');
      expect(err.retryable).toBe(false);
      expect(formatLlmTerminalError(err)).not.toContain('<');
      expect(formatLlmTerminalError(err)).not.toContain('content_policy');
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

    it('does not append a rawBody snippet to an empty classified error', () => {
      // We must never leak an opaque body (e.g. a WAF page) into the chat surface.
      const err = new LLMError('', 'not_found', { statusCode: 404, rawBody: '<html>blocked by proxy</html>' });
      const result = formatLlmDisplayError(err, '', emptyBodyFallback);
      expect(result).toBe('HTTP 404 · not_found');
      expect(result).not.toContain('html');
    });

    it('does not display a message-less JSON body from a classified provider error', () => {
      const err = classifyError(403, JSON.stringify({
        private: 'credential-adjacent provider metadata',
      }));

      const result = formatLlmDisplayError(err, err.message, emptyBodyFallback);

      expect(result).toBe('HTTP 403 · authentication');
      expect(result).not.toContain('private');
    });

    it('never falls back to a rawBody-backed message when status is unavailable', () => {
      const err = new LLMError('private provider response', 'unknown', {
        rawBody: 'private provider response',
      });

      expect(formatLlmTerminalError(err)).toBe('unknown');
      expect(formatLlmDisplayError(err, err.message, emptyBodyFallback)).toBe('unknown');
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
