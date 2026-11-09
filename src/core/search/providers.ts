/**
 * Search Provider Adapters
 *
 * Unified interface for multiple web search providers:
 * - Bing Web Search API
 * - Brave Search API
 * - Tavily Search API
 * - SearXNG (self-hosted, no API key needed)
 * - Keenable (keyless public endpoint, optional API key)
 *
 * All HTTP requests use getTauriFetch() to bypass CORS.
 */

import type { SearchResult, WebSearchResponse } from '../../types';
import { getTauriFetch } from '../llm/tauriFetch';

export interface SearchOptions {
  count: number;
  market: string;
  freshness?: string;
}

export interface SearchProvider {
  search(query: string, options: SearchOptions): Promise<WebSearchResponse>;
}

/** Extract domain from a URL */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// --- Bing Web Search API ---

export function createBingProvider(apiKey: string): SearchProvider {
  return {
    async search(query: string, options: SearchOptions): Promise<WebSearchResponse> {
      const fetchFn = await getTauriFetch();
      const params = new URLSearchParams({
        q: query,
        count: String(options.count),
        mkt: options.market,
        responseFilter: 'Webpages',
      });
      if (options.freshness) {
        params.set('freshness', options.freshness);
      }

      const response = await fetchFn(`https://api.bing.microsoft.com/v7.0/search?${params}`, {
        method: 'GET',
        headers: {
          'Ocp-Apim-Subscription-Key': apiKey,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Bing Search API error: ${response.status} ${errorText}`);
      }

      const data = await response.json() as {
        webPages?: {
          value: Array<{
            name: string;
            url: string;
            snippet: string;
            datePublished?: string;
          }>;
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

// --- Brave Search API ---

export function createBraveProvider(apiKey: string): SearchProvider {
  return {
    async search(query: string, options: SearchOptions): Promise<WebSearchResponse> {
      const fetchFn = await getTauriFetch();
      const params = new URLSearchParams({
        q: query,
        count: String(options.count),
      });
      if (options.freshness) {
        params.set('freshness', options.freshness);
      }

      const response = await fetchFn(`https://api.search.brave.com/res/v1/web/search?${params}`, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': apiKey,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Brave Search API error: ${response.status} ${errorText}`);
      }

      const data = await response.json() as {
        web?: {
          results: Array<{
            title: string;
            url: string;
            description: string;
            page_age?: string;
          }>;
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

// --- Tavily Search API ---

export function createTavilyProvider(apiKey: string): SearchProvider {
  return {
    async search(query: string, options: SearchOptions): Promise<WebSearchResponse> {
      const fetchFn = await getTauriFetch();

      const response = await fetchFn('https://api.tavily.com/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
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

      const data = await response.json() as {
        results: Array<{
          title: string;
          url: string;
          content: string;
          published_date?: string;
        }>;
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

// --- SearXNG (self-hosted) ---

export function createSearXNGProvider(baseUrl: string): SearchProvider {
  return {
    async search(query: string, options: SearchOptions): Promise<WebSearchResponse> {
      const fetchFn = await getTauriFetch();
      const cleanBaseUrl = baseUrl.replace(/\/+$/, '');
      const params = new URLSearchParams({
        q: query,
        format: 'json',
        pageno: '1',
      });

      const response = await fetchFn(`${cleanBaseUrl}/search?${params}`, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`SearXNG error: ${response.status} ${errorText}`);
      }

      const data = await response.json() as {
        results: Array<{
          title: string;
          url: string;
          content: string;
          publishedDate?: string;
        }>;
      };

      const results: SearchResult[] = (data.results || [])
        .slice(0, options.count)
        .map((item) => ({
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

// --- Keenable Search API ---

export const KEENABLE_APP_TITLE = 'Abu Cowork';

const KEENABLE_FRESHNESS_DAYS: Record<string, number> = { day: 1, week: 7, month: 31 };

/** Map the tool's Day/Week/Month freshness onto a `published_after` date (YYYY-MM-DD). */
export function keenablePublishedAfter(freshness: string | undefined, now: Date = new Date()): string | undefined {
  const days = freshness ? KEENABLE_FRESHNESS_DAYS[freshness.toLowerCase()] : undefined;
  if (!days) return undefined;
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Keenable works without an API key: keyless requests go to the public
 * endpoint (rate limited per IP) and must name the app in `X-Keenable-Title`.
 * An optional key switches to the keyed endpoint for a higher limit.
 */
export function createKeenableProvider(apiKey?: string): SearchProvider {
  const key = apiKey?.trim() ?? '';
  return {
    async search(query: string, options: SearchOptions): Promise<WebSearchResponse> {
      const fetchFn = await getTauriFetch();
      const url = key ? 'https://api.keenable.ai/v1/search' : 'https://api.keenable.ai/v1/search/public';
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (key) headers['X-API-Key'] = key;
      else headers['X-Keenable-Title'] = KEENABLE_APP_TITLE;

      const body: Record<string, unknown> = { query, max_results: options.count };
      const publishedAfter = keenablePublishedAfter(options.freshness);
      if (publishedAfter) body.published_after = publishedAfter;

      const response = await fetchFn(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Keenable Search API error: ${response.status} ${errorText}`);
      }

      const data = await response.json() as {
        results?: Array<{
          title?: string;
          url?: string;
          description?: string;
          snippet?: string;
          published_at?: string;
        }>;
      };

      const results: SearchResult[] = (data.results || [])
        .filter((item) => !!item.url)
        .slice(0, options.count)
        .map((item) => ({
          title: item.title || item.url!,
          url: item.url!,
          snippet: item.description || item.snippet || '',
          source: extractDomain(item.url!),
          publishedDate: item.published_at,
        }));

      return { query, results };
    },
  };
}

// --- Provider factory ---

export type WebSearchProviderType = 'bing' | 'brave' | 'tavily' | 'searxng' | 'keenable';

export function createSearchProvider(
  providerType: WebSearchProviderType,
  apiKey: string,
  baseUrl?: string,
): SearchProvider {
  switch (providerType) {
    case 'bing':
      return createBingProvider(apiKey);
    case 'brave':
      return createBraveProvider(apiKey);
    case 'tavily':
      return createTavilyProvider(apiKey);
    case 'searxng':
      return createSearXNGProvider(baseUrl || '');
    case 'keenable':
      return createKeenableProvider(apiKey);
  }
}
