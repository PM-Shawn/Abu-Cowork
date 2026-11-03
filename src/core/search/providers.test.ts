import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createBingProvider,
  createBraveProvider,
  createTavilyProvider,
  createSearXNGProvider,
  createKeenableProvider,
  createSearchProvider,
  keenablePublishedAfter,
  KEENABLE_APP_TITLE,
} from './providers';

// Mock getTauriFetch
const mockFetch = vi.fn();
vi.mock('../llm/tauriFetch', () => ({
  getTauriFetch: vi.fn().mockResolvedValue(
    (...args: Parameters<typeof fetch>) => mockFetch(...args)
  ),
}));

beforeEach(() => {
  mockFetch.mockReset();
});

const defaultOptions = { count: 5, market: 'zh-CN' };

describe('search providers', () => {
  describe('createBingProvider', () => {
    it('should parse Bing response correctly', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          webPages: {
            value: [
              { name: 'Test Title', url: 'https://example.com/page', snippet: 'A test snippet', datePublished: '2024-01-01' },
              { name: 'Another', url: 'https://other.com', snippet: 'More text' },
            ],
          },
        }),
      });

      const provider = createBingProvider('test-key');
      const result = await provider.search('test query', defaultOptions);

      expect(result.query).toBe('test query');
      expect(result.results).toHaveLength(2);
      expect(result.results[0]).toEqual({
        title: 'Test Title',
        url: 'https://example.com/page',
        snippet: 'A test snippet',
        source: 'example.com',
        publishedDate: '2024-01-01',
      });

      // Verify API key header
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('api.bing.microsoft.com'),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Ocp-Apim-Subscription-Key': 'test-key',
          }),
        }),
      );
    });

    it('should handle empty results', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      const provider = createBingProvider('test-key');
      const result = await provider.search('nothing', defaultOptions);

      expect(result.results).toHaveLength(0);
    });

    it('should throw on API error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      const provider = createBingProvider('bad-key');
      await expect(provider.search('test', defaultOptions)).rejects.toThrow('Bing Search API error: 401');
    });
  });

  describe('createBraveProvider', () => {
    it('should parse Brave response correctly', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          web: {
            results: [
              { title: 'Brave Result', url: 'https://brave.com/r', description: 'Found via Brave', page_age: '2 days ago' },
            ],
          },
        }),
      });

      const provider = createBraveProvider('brave-key');
      const result = await provider.search('brave test', defaultOptions);

      expect(result.results).toHaveLength(1);
      expect(result.results[0].title).toBe('Brave Result');
      expect(result.results[0].source).toBe('brave.com');
    });
  });

  describe('createTavilyProvider', () => {
    it('should send POST request with correct body', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [
            { title: 'Tavily Result', url: 'https://tavily.com/r', content: 'Deep search result' },
          ],
        }),
      });

      const provider = createTavilyProvider('tavily-key');
      const result = await provider.search('tavily test', defaultOptions);

      expect(result.results).toHaveLength(1);
      expect(result.results[0].snippet).toBe('Deep search result');

      // Verify POST request
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.tavily.com/search',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"api_key":"tavily-key"'),
        }),
      );
    });
  });

  describe('createSearXNGProvider', () => {
    it('should use base URL correctly', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [
            { title: 'SearXNG Result', url: 'https://example.org', content: 'Self-hosted search' },
          ],
        }),
      });

      const provider = createSearXNGProvider('http://localhost:8080');
      const result = await provider.search('searxng test', defaultOptions);

      expect(result.results).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('http://localhost:8080/search'),
        expect.any(Object),
      );
    });

    it('should strip trailing slashes from base URL', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ results: [] }),
      });

      const provider = createSearXNGProvider('http://localhost:8080///');
      await provider.search('test', defaultOptions);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('http://localhost:8080/search'),
        expect.any(Object),
      );
    });

    it('should limit results to count', async () => {
      const manyResults = Array.from({ length: 20 }, (_, i) => ({
        title: `Result ${i}`,
        url: `https://example.com/${i}`,
        content: `Content ${i}`,
      }));

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ results: manyResults }),
      });

      const provider = createSearXNGProvider('http://localhost:8080');
      const result = await provider.search('test', { count: 3, market: 'zh-CN' });

      expect(result.results).toHaveLength(3);
    });
  });

  describe('createKeenableProvider', () => {
    it('uses the keyless public endpoint with an app title when no key is set', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [
            { title: 'Keenable', url: 'https://www.keenable.ai/docs', description: 'Search API docs' },
            { title: 'No URL' },
            { title: 'Other', url: 'https://other.com/x', snippet: 'snippet only' },
          ],
        }),
      });

      const result = await createKeenableProvider('').search('keenable', defaultOptions);

      expect(result.results).toEqual([
        { title: 'Keenable', url: 'https://www.keenable.ai/docs', snippet: 'Search API docs', source: 'keenable.ai', publishedDate: undefined },
        { title: 'Other', url: 'https://other.com/x', snippet: 'snippet only', source: 'other.com', publishedDate: undefined },
      ]);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.keenable.ai/v1/search/public');
      expect(init.method).toBe('POST');
      expect(init.headers['X-Keenable-Title']).toBe(KEENABLE_APP_TITLE);
      expect(init.headers['X-API-Key']).toBeUndefined();
      expect(JSON.parse(init.body)).toEqual({ query: 'keenable', max_results: 5 });
    });

    it('uses the keyed endpoint and maps freshness when a key is set', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });

      await createKeenableProvider('keen-key').search('news', { count: 3, market: 'en-US', freshness: 'Week' });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.keenable.ai/v1/search');
      expect(init.headers['X-API-Key']).toBe('keen-key');
      expect(init.headers['X-Keenable-Title']).toBeUndefined();
      const body = JSON.parse(init.body);
      expect(body.max_results).toBe(3);
      expect(body.published_after).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('maps Day/Week/Month to a published_after date', () => {
      const now = new Date('2026-11-03T12:00:00Z');
      expect(keenablePublishedAfter('Day', now)).toBe('2026-11-02');
      expect(keenablePublishedAfter('week', now)).toBe('2026-10-27');
      expect(keenablePublishedAfter('Month', now)).toBe('2026-10-03');
      expect(keenablePublishedAfter(undefined, now)).toBeUndefined();
      expect(keenablePublishedAfter('Year', now)).toBeUndefined();
    });

    it('throws on an HTTP error', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 429, text: async () => 'rate limited' });
      await expect(createKeenableProvider().search('q', defaultOptions)).rejects.toThrow('Keenable Search API error: 429');
    });
  });

  describe('createSearchProvider', () => {
    it('should create a keyless Keenable provider', () => {
      const provider = createSearchProvider('keenable', '');
      expect(provider.search).toBeTypeOf('function');
    });

    it('should create Bing provider', () => {
      const provider = createSearchProvider('bing', 'key');
      expect(provider).toBeDefined();
      expect(provider.search).toBeTypeOf('function');
    });

    it('should create Brave provider', () => {
      const provider = createSearchProvider('brave', 'key');
      expect(provider).toBeDefined();
    });

    it('should create Tavily provider', () => {
      const provider = createSearchProvider('tavily', 'key');
      expect(provider).toBeDefined();
    });

    it('should create SearXNG provider with base URL', () => {
      const provider = createSearchProvider('searxng', '', 'http://my-searxng.local');
      expect(provider).toBeDefined();
    });

    it('should create SearXNG provider with empty base URL when not provided', () => {
      const provider = createSearchProvider('searxng', '');
      expect(provider).toBeDefined();
    });
  });
});
