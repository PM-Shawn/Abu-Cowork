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

    it('maps 403/404 to the "not supported, add manually" hint', async () => {
      stubFetch(() => jsonResponse({}, false, 404));

      const result = await fetchProviderModels('https://example.com/v1', 'k', 'openai-compatible');

      expect(result.success).toBe(false);
      expect(result.error).toContain('不支持自动获取');
    });

    it('surfaces any other status verbatim', async () => {
      stubFetch(() => jsonResponse({}, false, 500));

      const result = await fetchProviderModels('https://example.com/v1', 'k', 'openai-compatible');

      expect(result.error).toBe('HTTP 500');
    });

    it('reports a thrown transport error instead of rejecting', async () => {
      vi.mocked(getTauriFetch).mockResolvedValue((async () => {
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof globalThis.fetch);

      const result = await fetchProviderModels('https://example.com/v1', 'k', 'openai-compatible');

      expect(result.success).toBe(false);
      expect(result.error).toBe('TypeError: Failed to fetch');
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
