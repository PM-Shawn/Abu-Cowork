import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock search providers module
const mockSearch = vi.fn();
vi.mock('../search/providers', () => ({
  createSearchProvider: vi.fn(() => ({
    search: mockSearch,
  })),
}));

// Mock settingsStore — V2 shape uses auxiliaryServices
const mockSettingsState = {
  auxiliaryServices: {
    webSearch: {
      provider: 'brave' as const,
      apiKey: 'test-api-key',
      baseUrl: '',
    },
  },
};

vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => mockSettingsState,
  },
}));

// Import after mocking
import { registerBuiltinTools } from './builtins';
import { toolRegistry } from './registry';

// Register tools once
registerBuiltinTools();

beforeEach(() => {
  mockSearch.mockReset();
  // Reset settings to defaults
  mockSettingsState.auxiliaryServices.webSearch = {
    provider: 'brave',
    apiKey: 'test-api-key',
    baseUrl: '',
  };
});

describe('web_search tool', () => {
  function getWebSearchTool() {
    const tool = toolRegistry.get('web_search');
    expect(tool).toBeDefined();
    return tool!;
  }

  describe('validation', () => {
    it('should return error when API key is missing (default provider)', async () => {
      mockSettingsState.auxiliaryServices.webSearch!.apiKey = '';
      const tool = getWebSearchTool();

      const result = await tool.execute({ query: 'test' });
      expect(result).toContain('No search API Key configured');
    });

    it('should return error when API key is missing for Bing', async () => {
      mockSettingsState.auxiliaryServices.webSearch = { provider: 'bing', apiKey: '', baseUrl: '' };
      const tool = getWebSearchTool();

      const result = await tool.execute({ query: 'test' });
      expect(result).toContain('No search API Key configured');
    });

    it('should return error when SearXNG base URL is missing', async () => {
      mockSettingsState.auxiliaryServices.webSearch = { provider: 'searxng', apiKey: '', baseUrl: '' };
      const tool = getWebSearchTool();

      const result = await tool.execute({ query: 'test' });
      expect(result).toContain('No SearXNG URL configured');
    });

    it('should NOT require API key for SearXNG when base URL is set', async () => {
      mockSettingsState.auxiliaryServices.webSearch = { provider: 'searxng', apiKey: '', baseUrl: 'http://localhost:8080' };

      mockSearch.mockResolvedValue({
        query: 'test',
        results: [{ title: 'Result', url: 'https://example.com', snippet: 'A result' }],
      });

      const tool = getWebSearchTool();
      const result = await tool.execute({ query: 'test' });

      expect(result).not.toContain('No search API Key configured');
      expect(result).not.toContain('No SearXNG URL configured');
      expect(result).toContain('Search results');
    });
  });

  describe('successful search', () => {
    it('should return formatted results with SEARCH_JSON marker', async () => {
      mockSearch.mockResolvedValue({
        query: 'AI news',
        results: [
          { title: 'AI Progress', url: 'https://ai.com/news', snippet: 'Latest AI developments', source: 'ai.com' },
          { title: 'ML Update', url: 'https://ml.org/update', snippet: 'Machine learning news', source: 'ml.org' },
        ],
      });

      const tool = getWebSearchTool();
      const result = await tool.execute({ query: 'AI news' });

      // Should contain SEARCH_JSON marker
      expect(result).toContain('<!--SEARCH_JSON:');
      expect(result).toContain('-->');

      // Should contain readable output
      expect(result).toContain('Search results (2 total)');
      expect(result).toContain('**AI Progress**');
      expect(result).toContain('**ML Update**');
      expect(result).toContain('ai.com');
      expect(result).toContain('🔗 https://ai.com/news');
    });

    it('should embed valid JSON in the marker', async () => {
      const searchResults = [
        { title: 'Test', url: 'https://test.com', snippet: 'Test snippet', source: 'test.com' },
      ];
      mockSearch.mockResolvedValue({ query: 'test', results: searchResults });

      const tool = getWebSearchTool();
      const result = await tool.execute({ query: 'test' });

      const match = result.match(/<!--SEARCH_JSON:([\s\S]*?)-->/);
      expect(match).not.toBeNull();

      const parsed = JSON.parse(match![1]);
      expect(parsed).toEqual(searchResults);
    });

    it('should handle empty results', async () => {
      mockSearch.mockResolvedValue({ query: 'obscure query', results: [] });

      const tool = getWebSearchTool();
      const result = await tool.execute({ query: 'obscure query' });

      expect(result).toContain('No search results found');
      expect(result).toContain('obscure query');
      expect(result).not.toContain('SEARCH_JSON');
    });
  });

  describe('input parameters', () => {
    it('should use default count of 8', async () => {
      mockSearch.mockResolvedValue({ query: 'test', results: [] });
      const tool = getWebSearchTool();
      await tool.execute({ query: 'test' });

      expect(mockSearch).toHaveBeenCalledWith('test', expect.objectContaining({ count: 8 }));
    });

    it('should clamp count to max 20', async () => {
      mockSearch.mockResolvedValue({ query: 'test', results: [] });
      const tool = getWebSearchTool();
      await tool.execute({ query: 'test', count: 100 });

      expect(mockSearch).toHaveBeenCalledWith('test', expect.objectContaining({ count: 20 }));
    });

    it('should clamp count to min 1', async () => {
      mockSearch.mockResolvedValue({ query: 'test', results: [] });
      const tool = getWebSearchTool();
      await tool.execute({ query: 'test', count: -5 });

      expect(mockSearch).toHaveBeenCalledWith('test', expect.objectContaining({ count: 1 }));
    });

    it('should use default market zh-CN', async () => {
      mockSearch.mockResolvedValue({ query: 'test', results: [] });
      const tool = getWebSearchTool();
      await tool.execute({ query: 'test' });

      expect(mockSearch).toHaveBeenCalledWith('test', expect.objectContaining({ market: 'zh-CN' }));
    });

    it('should pass custom market', async () => {
      mockSearch.mockResolvedValue({ query: 'test', results: [] });
      const tool = getWebSearchTool();
      await tool.execute({ query: 'test', market: 'en-US' });

      expect(mockSearch).toHaveBeenCalledWith('test', expect.objectContaining({ market: 'en-US' }));
    });

    it('should pass freshness filter', async () => {
      mockSearch.mockResolvedValue({ query: 'test', results: [] });
      const tool = getWebSearchTool();
      await tool.execute({ query: 'test', freshness: 'Day' });

      expect(mockSearch).toHaveBeenCalledWith('test', expect.objectContaining({ freshness: 'Day' }));
    });
  });

  describe('error handling', () => {
    it('should return friendly error when provider throws', async () => {
      mockSearch.mockRejectedValue(new Error('Network timeout'));
      const tool = getWebSearchTool();

      const result = await tool.execute({ query: 'test' });
      expect(result).toContain('Search error');
      expect(result).toContain('Network timeout');
    });

    it('should handle non-Error throws', async () => {
      mockSearch.mockRejectedValue('unexpected string error');
      const tool = getWebSearchTool();

      const result = await tool.execute({ query: 'test' });
      expect(result).toContain('Search error');
      expect(result).toContain('unexpected string error');
    });
  });

  describe('tool definition', () => {
    it('should be registered with correct name', () => {
      expect(toolRegistry.get('web_search')).toBeDefined();
    });

    it('should require query parameter', () => {
      const tool = getWebSearchTool();
      expect(tool.inputSchema.required).toContain('query');
    });

    it('should have description mentioning web search', () => {
      const tool = getWebSearchTool();
      expect(tool.description.toLowerCase()).toContain('search');
    });
  });
});
