import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderInstance } from '@/types/provider';
import { LLMError, classifyError } from './adapter';
import { checkProviderHealth } from './healthCheck';

const mocks = vi.hoisted(() => ({ chat: vi.fn(), fetch: vi.fn() }));

vi.mock('./openai-compatible', () => ({
  OpenAICompatibleAdapter: class {
    chat = mocks.chat;
  },
}));
vi.mock('./claude', () => ({
  ClaudeAdapter: class {
    chat = mocks.chat;
  },
}));
vi.mock('./tauriFetch', () => ({ getTauriFetch: async () => mocks.fetch }));

const FAKE_KEY = 'sk-test-not-a-secret';
const FAKE_UPSTREAM_TOKEN = 'test-bearer-token-not-a-secret';

function provider(overrides: Partial<ProviderInstance> = {}): ProviderInstance {
  return {
    id: 'custom-health',
    source: 'custom',
    name: 'Health',
    enabled: true,
    apiFormat: 'openai-compatible',
    baseUrl: 'https://llm.example.test/v1',
    apiKey: FAKE_KEY,
    models: [{ id: 'model-a', label: 'model-a' }],
    status: 'unchecked',
    sortOrder: 0,
    ...overrides,
  };
}

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

describe('checkProviderHealth', () => {
  let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;

  beforeEach(() => {
    mocks.chat.mockReset();
    mocks.fetch.mockReset();
    consoleSpies = CONSOLE_METHODS.map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function loggedText(): string {
    return consoleSpies
      .flatMap((spy) => spy.mock.calls)
      .map((args) => args.map((arg: unknown) => (arg instanceof Error ? `${arg.message}\n${arg.stack}` : JSON.stringify(arg))).join(' '))
      .join('\n');
  }

  describe('failure text', () => {
    it('removes the provider key echoed in a JSON error message', async () => {
      mocks.chat.mockRejectedValue(
        classifyError(401, JSON.stringify({ error: { message: `Incorrect API key provided: ${FAKE_KEY}` } })),
      );

      const result = await checkProviderHealth(provider());

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('authentication');
      expect(result.statusCode).toBe(401);
      expect(result.error).toContain('Incorrect API key provided');
      expect(result.error).not.toContain(FAKE_KEY);
      expect(loggedText()).not.toContain(FAKE_KEY);
    });

    it('removes a key that has no recognisable shape', async () => {
      const shapelessKey = 'plainTestKeyNotASecret';
      mocks.chat.mockRejectedValue(classifyError(403, `invalid credential ${shapelessKey} for this gateway`));

      const result = await checkProviderHealth(provider({ apiKey: shapelessKey }));

      expect(result.error).toBe('invalid credential [REDACTED] for this gateway');
    });

    it('removes the URL-encoded forms of the provider key', async () => {
      const key = 'test/key+not=a-secret';
      const encoded = encodeURIComponent(key);
      const lowerHex = 'test%2fkey%2bnot%3da-secret';
      mocks.chat.mockRejectedValue(
        new LLMError(`request to https://llm.example.test/v1/chat?k=${encoded} failed, retried ?k=${lowerHex}`, 'network_error'),
      );

      const result = await checkProviderHealth(provider({ apiKey: key }));

      expect(result.error).toBe(
        'request to https://llm.example.test/v1/chat?k=[REDACTED] failed, retried ?k=[REDACTED]',
      );
    });

    it('removes the JSON-escaped form of the provider key', async () => {
      const key = 'test"key\\not-a-secret';
      mocks.chat.mockRejectedValue(classifyError(400, `bad request body: {"credential":${JSON.stringify(key)}}`));

      const result = await checkProviderHealth(provider({ apiKey: key }));

      expect(result.error).toBe('bad request body: {"credential":"[REDACTED]"}');
    });

    it('removes an echoed Basic credential', async () => {
      mocks.chat.mockRejectedValue(
        classifyError(407, 'proxy rejected Proxy-Authorization: Basic dGVzdDpub3QtYS1zZWNyZXQ= for this host'),
      );

      const result = await checkProviderHealth(provider());

      expect(result.error).toBe('proxy rejected Proxy-Authorization: [REDACTED] for this host');
    });

    it('leaves the text readable when the key is a short placeholder', async () => {
      mocks.chat.mockRejectedValue(new LLMError('ollama server is not running', 'network_error'));

      const result = await checkProviderHealth(provider({ apiKey: 'ollama' }));

      expect(result.error).toBe('ollama server is not running');
    });

    it('still returns a result when the key is not well-formed UTF-16', async () => {
      const key = 'test-key\uD800-not-a-secret';
      mocks.chat.mockRejectedValue(new LLMError(`rejected ${key}`, 'network_error'));

      const result = await checkProviderHealth(provider({ apiKey: key }));

      expect(result.error).toBe('rejected [REDACTED]');
    });

    it('removes an echoed Authorization header that carries another token', async () => {
      mocks.chat.mockRejectedValue(
        classifyError(401, `upstream rejected request headers: Authorization: Bearer ${FAKE_UPSTREAM_TOKEN}`),
      );

      const result = await checkProviderHealth(provider());

      expect(result.error).not.toContain(FAKE_UPSTREAM_TOKEN);
      expect(result.error).toContain('upstream rejected request headers');
    });

    it('removes key-like query parameters from an echoed URL', async () => {
      mocks.chat.mockRejectedValue(
        new LLMError(
          `fetch failed: https://llm.example.test/v1/models?alt=sse&key=${FAKE_UPSTREAM_TOKEN}&api_key=other-test-value`,
          'network_error',
        ),
      );

      const result = await checkProviderHealth(provider());

      expect(result.error).toBe(
        'fetch failed: https://llm.example.test/v1/models?alt=sse&key=[REDACTED]&api_key=[REDACTED]',
      );
    });

    it('removes query parameters whose name contains a secret-like word', async () => {
      mocks.chat.mockRejectedValue(
        new LLMError(
          'fetch failed: https://llm.example.test/v1/models?alt=sse&client_secret=test-value-1&sig=test-value-2&subscription-key=test-value-3',
          'network_error',
        ),
      );

      const result = await checkProviderHealth(provider());

      expect(result.error).toBe(
        'fetch failed: https://llm.example.test/v1/models?alt=sse&client_secret=[REDACTED]&sig=[REDACTED]&subscription-key=[REDACTED]',
      );
    });

    it('removes the account and password from an echoed URL', async () => {
      mocks.chat.mockRejectedValue(
        new LLMError(
          `Request cannot be constructed from a URL that includes credentials: https://user:${FAKE_UPSTREAM_TOKEN}@llm.example.test/v1/chat/completions`,
          'network_error',
        ),
      );

      const result = await checkProviderHealth(provider());

      expect(result.error).toBe(
        'Request cannot be constructed from a URL that includes credentials: https://[REDACTED]@llm.example.test/v1/chat/completions',
      );
    });

    it('keeps a URL without an account intact', async () => {
      mocks.chat.mockRejectedValue(
        new LLMError('no route to https://llm.example.test:8443/v1/chat/completions, contact ops@example.test', 'network_error'),
      );

      const result = await checkProviderHealth(provider());

      expect(result.error).toBe('no route to https://llm.example.test:8443/v1/chat/completions, contact ops@example.test');
    });

    it('caps the text at 500 characters', async () => {
      mocks.chat.mockRejectedValue(classifyError(500, 'x'.repeat(5000)));

      const result = await checkProviderHealth(provider());

      expect(result.error).toHaveLength(500);
    });

    it('redacts a non-LLMError exception', async () => {
      mocks.chat.mockRejectedValue(new TypeError(`bad header value ${FAKE_KEY}`));

      const result = await checkProviderHealth(provider());

      expect(result.error).toBe('TypeError: bad header value [REDACTED]');
    });

    it('redacts the exception thrown by the LM Studio probe', async () => {
      mocks.fetch.mockRejectedValue(new Error(`connect ECONNREFUSED, sent Authorization: Bearer ${FAKE_KEY}`));

      const result = await checkProviderHealth(provider({ id: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1' }));

      expect(result.success).toBe(false);
      expect(result.error).toContain('connect ECONNREFUSED');
      expect(result.error).not.toContain(FAKE_KEY);
    });

    it('redacts the exception thrown by the Ollama probe', async () => {
      mocks.fetch.mockRejectedValue(new Error(`proxy refused http://127.0.0.1:11434/api/tags?token=${FAKE_UPSTREAM_TOKEN}`));

      const result = await checkProviderHealth(provider({ id: 'ollama', apiKey: '', baseUrl: 'http://127.0.0.1:11434' }));

      expect(result.success).toBe(false);
      expect(result.error).not.toContain(FAKE_UPSTREAM_TOKEN);
    });

    it('keeps ordinary text intact when the provider has no key', async () => {
      mocks.chat.mockRejectedValue(classifyError(404, JSON.stringify({ error: { message: 'model model-a not found' } })));

      const result = await checkProviderHealth(provider({ apiKey: '' }));

      expect(result.error).toBe('model model-a not found');
    });
  });

  describe('success', () => {
    it('reports no error text', async () => {
      mocks.chat.mockResolvedValue(undefined);

      const result = await checkProviderHealth(provider());

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });
});
