import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchProviderModels, isChatModelId } from './modelFetcher';
import { getTauriFetch } from './tauriFetch';

vi.mock('./tauriFetch', () => ({ getTauriFetch: vi.fn() }));

/** Install a fetch stub and return the spy so tests can assert on url/headers. */
function stubFetch(impl: (url: string, init?: RequestInit) => unknown) {
  const spy = vi.fn(async (url: string, init?: RequestInit) => impl(url, init));
  vi.mocked(getTauriFetch).mockResolvedValue(spy as unknown as typeof globalThis.fetch);
  return spy;
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

describe('modelFetcher', () => {
  beforeEach(() => {
    vi.mocked(getTauriFetch).mockReset();
  });

  describe('isChatModelId', () => {
    it.each([
      'text-embedding-3-large',
      'whisper-1',
      'tts-1-hd',
      'dall-e-3',
      'omni-moderation-latest',
      'gpt-4o-transcribe',
      'gpt-4o-mini-tts',
      'gpt-realtime',
      'sora-2',
      'gpt-4o-audio-preview',
    ])('excludes non-chat SKU %s', (id) => {
      expect(isChatModelId(id)).toBe(false);
    });

    it.each([
      'gpt-5.6-sol',
      'claude-opus-5',
      'deepseek-v4-pro',
      'kimi-k3',
      'glm-5.2',
      'MiniMax-M3',
      'doubao-seed-2.1-pro',
      'qwen3.8-max',
    ])('keeps chat model %s', (id) => {
      expect(isChatModelId(id)).toBe(true);
    });
  });

  describe('OpenAI-compatible fallback', () => {
    it('GETs {base}/models with a Bearer header and maps data[].id', async () => {
      const spy = stubFetch(() => jsonResponse({ data: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-v4-flash' }] }));

      const result = await fetchProviderModels('https://api.deepseek.com', 'sk-test', 'openai-compatible');

      expect(spy).toHaveBeenCalledTimes(1);
      const [url, init] = spy.mock.calls[0];
      expect(url).toBe('https://api.deepseek.com/v1/models');
      expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-test');
      expect(result.success).toBe(true);
      expect(result.models.map((m) => m.id)).toEqual(['deepseek-v4-pro', 'deepseek-v4-flash']);
    });

    it('does not double-append /v1 when the base already ends in a version segment', async () => {
      const spy = stubFetch(() => jsonResponse({ data: [] }));

      await fetchProviderModels('https://ark.cn-beijing.volces.com/api/plan/v3', 'k', 'openai-compatible');

      expect(spy.mock.calls[0][0]).toBe('https://ark.cn-beijing.volces.com/api/plan/v3/models');
    });

    it('omits the Authorization header entirely for a keyless local endpoint', async () => {
      const spy = stubFetch(() => jsonResponse({ data: [] }));

      await fetchProviderModels('http://127.0.0.1:1234/v1', '', 'openai-compatible');

      expect((spy.mock.calls[0][1]?.headers as Record<string, string>)['Authorization']).toBeUndefined();
    });

    it('filters non-chat SKUs out of the catalog', async () => {
      stubFetch(() => jsonResponse({
        data: [{ id: 'gpt-5.6-sol' }, { id: 'text-embedding-3-large' }, { id: 'gpt-4o-realtime-preview' }],
      }));

      const result = await fetchProviderModels('https://api.openai.com', 'sk', 'openai-compatible');

      expect(result.models.map((m) => m.id)).toEqual(['gpt-5.6-sol']);
    });

    it.each([
      [404, 'unsupported'],
      [403, 'forbidden'],
      [401, 'unauthorized'],
      [500, 'http'],
    ] as const)('maps HTTP %i to errorCode %s', async (status, code) => {
      stubFetch(() => jsonResponse({}, false, status));

      const result = await fetchProviderModels('https://example.com/v1', 'k', 'openai-compatible');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(code);
      expect(result.status).toBe(status);
      expect(result.error).toBe(`HTTP ${status}`);
    });

    it('keeps 403 distinct from 404 — "key may not list" is not "endpoint absent"', async () => {
      stubFetch(() => jsonResponse({}, false, 403));
      const forbidden = await fetchProviderModels('https://x/v1', 'k', 'openai-compatible');
      stubFetch(() => jsonResponse({}, false, 404));
      const missing = await fetchProviderModels('https://x/v1', 'k', 'openai-compatible');

      expect(forbidden.errorCode).not.toBe(missing.errorCode);
    });

    it('carries no user-facing prose — core returns codes, the UI translates', async () => {
      stubFetch(() => jsonResponse({}, false, 404));

      const result = await fetchProviderModels('https://example.com/v1', 'k', 'openai-compatible');

      expect(result.error).not.toMatch(/[\u4e00-\u9fa5]/);
    });

    it('reports a thrown transport error instead of rejecting', async () => {
      vi.mocked(getTauriFetch).mockResolvedValue((async () => {
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof globalThis.fetch);

      const result = await fetchProviderModels('https://example.com/v1', 'k', 'openai-compatible');

      expect(result.success).toBe(false);
      expect(result.error).toBe('TypeError: Failed to fetch');
      expect(result.errorCode).toBe('transport');
    });

    describe('failure text', () => {
      const FAKE_KEY = 'sk-test-not-a-secret';
      const FAKE_URL_PASSWORD = 'test-password-not-a-secret';

      function throwing(error: Error) {
        vi.mocked(getTauriFetch).mockResolvedValue((async () => {
          throw error;
        }) as unknown as typeof globalThis.fetch);
      }

      it('removes the account and password of a base URL echoed by the exception', async () => {
        const baseUrl = `https://user:${FAKE_URL_PASSWORD}@gateway.example.test/v1`;
        throwing(new TypeError(`Request cannot be constructed from a URL that includes credentials: ${baseUrl}/models`));

        const result = await fetchProviderModels(baseUrl, FAKE_KEY, 'openai-compatible');

        expect(result.error).toBe(
          'TypeError: Request cannot be constructed from a URL that includes credentials: [REDACTED]/models',
        );
        expect(result.errorCode).toBe('transport');
      });

      it.each([
        ['a slash', 'https://user:test-pass/word-not-a-secret@gateway.example.test/v1'],
        ['a question mark', 'https://user:test-pass?word-not-a-secret@gateway.example.test/v1'],
        ['a hash', 'https://user:test-pass#word-not-a-secret@gateway.example.test/v1'],
        ['an at sign', 'https://user:test-pass@word-not-a-secret@gateway.example.test/v1'],
        ['a space', 'https://user:test-pass word-not-a-secret@gateway.example.test/v1'],
        ['a quote', 'https://user:test-pass"word-not-a-secret@gateway.example.test/v1'],
        ['no scheme in front', '//user:test-pass-word-not-a-secret@gateway.example.test/v1'],
      ])('removes a URL password with %s', async (_label, baseUrl) => {
        throwing(new TypeError(`Failed to parse URL from ${baseUrl}/models`));

        const result = await fetchProviderModels(`  ${baseUrl}/ `, FAKE_KEY, 'openai-compatible');

        expect(result.error).toBe('TypeError: Failed to parse URL from [REDACTED]/models');
      });

      it('removes a key carried in the query string of an unparseable base URL', async () => {
        const baseUrl = `https://gateway.example.test:99999/v1?api_key=${FAKE_URL_PASSWORD}`;
        throwing(new TypeError(`Failed to parse URL from ${baseUrl}/models`));

        const result = await fetchProviderModels(baseUrl, FAKE_KEY, 'openai-compatible');

        expect(result.error).not.toContain(FAKE_URL_PASSWORD);
        expect(result.error).toContain('Failed to parse URL from https://gateway.example.test:99999/v1?api_key=[REDACTED]');
      });

      it('removes the provider key echoed by the exception', async () => {
        throwing(new Error(`proxy rejected header x-api-key ${FAKE_KEY}`));

        const result = await fetchProviderModels('https://gateway.example.test', FAKE_KEY, 'anthropic');

        expect(result.error).toBe('Error: proxy rejected header x-api-key [REDACTED]');
      });

      it('reports a non-JSON body without quoting any of it', async () => {
        const body = `key=${FAKE_KEY.slice(0, 14)}`;
        stubFetch(() => new Response(body, { status: 200 }));

        const result = await fetchProviderModels('https://gateway.example.test/v1', FAKE_KEY, 'openai-compatible');

        expect(result.success).toBe(false);
        expect(result.error).toBe('SyntaxError: response is not valid JSON');
      });
    });

    it('treats a missing data array as an empty catalog, not a crash', async () => {
      stubFetch(() => jsonResponse({}));

      const result = await fetchProviderModels('https://example.com/v1', 'k', 'openai-compatible');

      expect(result).toMatchObject({ success: true, models: [] });
    });
  });

  describe('Anthropic fetcher', () => {
    it('authenticates with x-api-key + anthropic-version, never Bearer', async () => {
      const spy = stubFetch(() => jsonResponse({ data: [] }));

      await fetchProviderModels('https://api.anthropic.com', 'sk-ant-test', 'anthropic');

      const headers = spy.mock.calls[0][1]?.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe('sk-ant-test');
      expect(headers['anthropic-version']).toBe('2023-06-01');
      expect(headers['Authorization']).toBeUndefined();
    });

    it('requests an explicit limit — the endpoint paginates at 20 by default', async () => {
      const spy = stubFetch(() => jsonResponse({ data: [] }));

      await fetchProviderModels('https://api.anthropic.com', 'k', 'anthropic');

      expect(spy.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/models?limit=1000');
    });

    it('prefers display_name as the label and falls back to the id', async () => {
      stubFetch(() => jsonResponse({
        data: [
          { id: 'claude-opus-5', display_name: 'Claude Opus 5' },
          { id: 'claude-sonnet-5' },
        ],
      }));

      const result = await fetchProviderModels('https://api.anthropic.com', 'k', 'anthropic');

      expect(result.models.map((m) => [m.id, m.label])).toEqual([
        ['claude-opus-5', 'Claude Opus 5'],
        ['claude-sonnet-5', 'claude-sonnet-5'],
      ]);
    });

    it('no longer refuses the anthropic format outright (it used to hard-fail)', async () => {
      stubFetch(() => jsonResponse({ data: [{ id: 'claude-opus-5' }] }));

      const result = await fetchProviderModels('https://api.anthropic.com', 'k', 'anthropic');

      expect(result.success).toBe(true);
      expect(result.models).toHaveLength(1);
    });

    it('falls back to the official host when the base URL is blank', async () => {
      const spy = stubFetch(() => jsonResponse({ data: [] }));

      await fetchProviderModels('', 'k', 'anthropic');

      expect(spy.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/models?limit=1000');
    });

    it('routes an anthropic-format custom proxy through the same fetcher', async () => {
      const spy = stubFetch(() => jsonResponse({ data: [] }));

      await fetchProviderModels('https://proxy.example.com/', 'k', 'anthropic');

      expect(spy.mock.calls[0][0]).toBe('https://proxy.example.com/v1/models?limit=1000');
    });
  });
});

describe('fetchProviderModels — context window reported by llama.cpp', () => {
  beforeEach(() => {
    vi.mocked(getTauriFetch).mockReset();
  });

  it('keeps data[].meta.n_ctx as ModelInfo.contextWindow', async () => {
    stubFetch(() => jsonResponse({ data: [{ id: 'qwen3-8b-q4', meta: { n_ctx: 8192 } }, { id: 'plain-model' }] }));
    const result = await fetchProviderModels('http://127.0.0.1:8080/v1', '', 'openai-compatible');
    expect(result.models.find((m) => m.id === 'qwen3-8b-q4')?.contextWindow).toBe(8192);
    expect(result.models.find((m) => m.id === 'plain-model')?.contextWindow).toBeUndefined();
  });
});
