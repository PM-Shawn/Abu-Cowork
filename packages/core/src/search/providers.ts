import type { SearchResult, WebSearchResponse } from '../../../../src/types';
import type { FetchAdapter } from '../ports/adapters/fetch';

export interface SearchOptions {
  count: number;
  market: string;
  freshness?: string;
}

export interface SearchProvider {
  search(query: string, options: SearchOptions): Promise<WebSearchResponse>;
}

export type WebSearchProviderType = 'bing' | 'brave' | 'tavily' | 'searxng';

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * 对比 Abu 原版改动：
 * - 原版每个 provider 内部 `await getTauriFetch()`；
 * - 新版 createXxxProvider 接受 FetchAdapter 作为首个参数。
 */

export function createBingProvider(fetchAdapter: FetchAdapter, apiKey: string): SearchProvider {
  return {
    async search(query, options) {
      const params = new URLSearchParams({
        q: query,
        count: String(options.count),
        mkt: options.market,
        responseFilter: 'Webpages',
      });
      if (options.freshness) params.set('freshness', options.freshness);

      const response = await fetchAdapter.fetch(
        `https://api.bing.microsoft.com/v7.0/search?${params}`,
        { method: 'GET', headers: { 'Ocp-Apim-Subscription-Key': apiKey } }
      );
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Bing Search API error: ${response.status} ${errorText}`);
      }
      const data = (await response.json()) as {
        webPages?: {
          value: Array<{ name: string; url: string; snippet: string; datePublished?: string }>;
        };
      };
      const results: SearchResult[] = (data.webPages?.value || []).map((item) => ({
        title: item.name,
        url: item.url,
        snippet: item.snippet,
        source: extractDomain(item.url),
        publishedDate: item.datePublished,
      }));
      return { query, results };
    },
  };
}

export function createBraveProvider(fetchAdapter: FetchAdapter, apiKey: string): SearchProvider {
  return {
    async search(query, options) {
      const params = new URLSearchParams({ q: query, count: String(options.count) });
      if (options.freshness) params.set('freshness', options.freshness);

      const response = await fetchAdapter.fetch(
        `https://api.search.brave.com/res/v1/web/search?${params}`,
        {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'Accept-Encoding': 'gzip',
            'X-Subscription-Token': apiKey,
          },
        }
      );
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Brave Search API error: ${response.status} ${errorText}`);
      }
      const data = (await response.json()) as {
        web?: {
          results: Array<{ title: string; url: string; description: string; page_age?: string }>;
        };
      };
      const results: SearchResult[] = (data.web?.results || []).map((item) => ({
        title: item.title,
        url: item.url,
        snippet: item.description,
        source: extractDomain(item.url),
        publishedDate: item.page_age,
      }));
      return { query, results };
    },
  };
}

export function createTavilyProvider(fetchAdapter: FetchAdapter, apiKey: string): SearchProvider {
  return {
    async search(query, options) {
      const response = await fetchAdapter.fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          max_results: options.count,
          search_depth: 'basic',
        }),
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Tavily Search API error: ${response.status} ${errorText}`);
      }
      const data = (await response.json()) as {
        results: Array<{ title: string; url: string; content: string; published_date?: string }>;
      };
      const results: SearchResult[] = (data.results || []).map((item) => ({
        title: item.title,
        url: item.url,
        snippet: item.content,
        source: extractDomain(item.url),
        publishedDate: item.published_date,
      }));
      return { query, results };
    },
  };
}

export function createSearXNGProvider(
  fetchAdapter: FetchAdapter,
  baseUrl: string
): SearchProvider {
  return {
    async search(query, options) {
      const cleanBaseUrl = baseUrl.replace(/\/+$/, '');
      const params = new URLSearchParams({ q: query, format: 'json', pageno: '1' });
      const response = await fetchAdapter.fetch(`${cleanBaseUrl}/search?${params}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`SearXNG error: ${response.status} ${errorText}`);
      }
      const data = (await response.json()) as {
        results: Array<{ title: string; url: string; content: string; publishedDate?: string }>;
      };
      const results: SearchResult[] = (data.results || []).slice(0, options.count).map((item) => ({
        title: item.title,
        url: item.url,
        snippet: item.content,
        source: extractDomain(item.url),
        publishedDate: item.publishedDate,
      }));
      return { query, results };
    },
  };
}

export function createSearchProvider(
  fetchAdapter: FetchAdapter,
  providerType: WebSearchProviderType,
  apiKey: string,
  baseUrl?: string
): SearchProvider {
  switch (providerType) {
    case 'bing':
      return createBingProvider(fetchAdapter, apiKey);
    case 'brave':
      return createBraveProvider(fetchAdapter, apiKey);
    case 'tavily':
      return createTavilyProvider(fetchAdapter, apiKey);
    case 'searxng':
      return createSearXNGProvider(fetchAdapter, baseUrl || '');
  }
}
