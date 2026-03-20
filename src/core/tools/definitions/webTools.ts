import type { ToolDefinition } from '../../../types';
import { getTauriFetch } from '../../llm/tauriFetch';
import { useSettingsStore } from '../../../stores/settingsStore';
import { TOOL_NAMES } from '../toolNames';

export const webSearchTool: ToolDefinition = {
  name: TOOL_NAMES.WEB_SEARCH,
  description: 'Search the web for information. Returns search results with titles, URLs, and snippets. Use this when: (1) you encounter unfamiliar terms, proper nouns, or product names, (2) the user asks to research/investigate a topic, (3) you need current information. IMPORTANT: Keep proper nouns in original form (e.g. "OpenClaw" not "开放爪子"), prefer searching over guessing.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
      count: { type: 'number', description: 'Number of results to return (default 8, max 20)' },
      market: { type: 'string', description: 'Market/locale for results (default: zh-CN)' },
      freshness: { type: 'string', description: 'Freshness filter: Day, Week, Month (optional)' },
    },
    required: ['query'],
  },
  execute: async (input) => {
    const query = input.query as string;
    const count = Math.min(Math.max(1, Number(input.count) || 8), 20);
    const market = (input.market as string) || 'zh-CN';
    const freshness = input.freshness as string | undefined;

    try {

      const state = useSettingsStore.getState();

      const providerType = state.webSearchProvider || 'bing';
      const apiKey = state.webSearchApiKey;
      const baseUrl = state.webSearchBaseUrl;

      // SearXNG doesn't need API key
      if (providerType !== 'searxng' && !apiKey) {
        return '未配置搜索 API Key。请在设置 → 网络搜索中配置搜索引擎的 API Key。\n\nNo search API Key configured. Please go to Settings → Web Search to configure your search engine API Key.';
      }
      if (providerType === 'searxng' && !baseUrl) {
        return '未配置 SearXNG 服务地址。请在设置 → 网络搜索中配置 SearXNG 实例地址。\n\nNo SearXNG URL configured. Please go to Settings → Web Search to configure your SearXNG instance URL.';
      }

      const { createSearchProvider } = await import('../../search/providers');
      const provider = createSearchProvider(providerType, apiKey, baseUrl);
      const response = await provider.search(query, { count, market, freshness });

      if (response.results.length === 0) {
        return `没有找到与 "${query}" 相关的搜索结果。`;
      }

      // Build output with hidden JSON marker for UI parsing + readable text for LLM
      const jsonMarker = `<!--SEARCH_JSON:${JSON.stringify(response.results)}-->`;

      const lines = response.results.map((r, i) => {
        const domain = r.source || '';
        return `${i + 1}. **${r.title}** — ${domain}\n   ${r.snippet}\n   🔗 ${r.url}`;
      });

      return `${jsonMarker}\n\n搜索结果 (共 ${response.results.length} 条):\n\n${lines.join('\n\n')}`;
    } catch (err) {
      return `搜索出错: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const httpFetchTool: ToolDefinition = {
  name: TOOL_NAMES.HTTP_FETCH,
  description: '发送 HTTP 请求到任意 URL。支持 GET/POST/PUT/DELETE/PATCH 方法。比通过 run_command 执行 curl 更可靠且跨平台。返回 HTTP 状态码和响应内容。',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to request' },
      method: { type: 'string', description: 'HTTP method: GET, POST, PUT, DELETE, PATCH (default: GET)' },
      headers: { type: 'object', description: 'Optional HTTP headers as key-value pairs' },
      body: { type: 'string', description: 'Optional request body (for POST/PUT/PATCH)' },
    },
    required: ['url'],
  },
  execute: async (input) => {
    const url = input.url as string;
    const method = ((input.method as string) || 'GET').toUpperCase();
    const headers = (input.headers as Record<string, string>) || {};
    const body = input.body as string | undefined;

    try {
      const fetchFn = await getTauriFetch();

      const options: RequestInit = {
        method,
        headers,
      };
      if (body && ['POST', 'PUT', 'PATCH'].includes(method)) {
        options.body = body;
      }

      const response = await fetchFn(url, options);

      const MAX_RESPONSE_LENGTH = 50000;
      let responseBody = await response.text();

      // Pretty-print JSON only if response is small enough to avoid memory spikes
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json') && responseBody.length <= MAX_RESPONSE_LENGTH * 2) {
        try {
          responseBody = JSON.stringify(JSON.parse(responseBody), null, 2);
        } catch {
          // Not valid JSON despite content-type; use raw text
        }
      }

      if (responseBody.length > MAX_RESPONSE_LENGTH) {
        responseBody = responseBody.slice(0, MAX_RESPONSE_LENGTH) + `\n\n... [Truncated: response was ${responseBody.length} chars, showing first ${MAX_RESPONSE_LENGTH}]`;
      }

      return `HTTP ${response.status} ${response.statusText}\n\n${responseBody}`;
    } catch (err) {
      return `Error making HTTP request: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
