/**
 * TokenManager Tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock getTauriFetch to return our mockFetch
const mockFetch = vi.fn();
vi.mock('../llm/tauriFetch', () => ({
  getTauriFetch: () => Promise.resolve(mockFetch),
}));

// Import after mocking
import { tokenManager } from './tokenManager';

describe('TokenManager', () => {
  beforeEach(() => {
    tokenManager.clear();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getToken - Feishu', () => {
    it('fetches and caches feishu tenant_access_token', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 0,
          tenant_access_token: 't-feishu-123',
          expire: 7200,
        }),
      });

      const token = await tokenManager.getToken('feishu', 'app1', 'secret1');
      expect(token).toBe('t-feishu-123');
      expect(mockFetch).toHaveBeenCalledOnce();

      // Second call should use cache
      const token2 = await tokenManager.getToken('feishu', 'app1', 'secret1');
      expect(token2).toBe('t-feishu-123');
      expect(mockFetch).toHaveBeenCalledOnce(); // Still once
    });

    it('throws on feishu API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 10003, msg: 'Invalid app_secret' }),
      });

      await expect(tokenManager.getToken('feishu', 'bad', 'bad'))
        .rejects.toThrow('Invalid app_secret');
    });

    it('throws on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      await expect(tokenManager.getToken('feishu', 'app1', 'secret1'))
        .rejects.toThrow('HTTP 500');
    });
  });

  describe('getToken - Slack', () => {
    it('returns appSecret as token (no API call)', async () => {
      const token = await tokenManager.getToken('slack', 'slack-app', 'xoxb-bot-token');
      expect(token).toBe('xoxb-bot-token');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('getToken - WeCom', () => {
    it('fetches wecom access_token', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          errcode: 0,
          access_token: 'wecom-token-456',
          expires_in: 7200,
        }),
      });

      const token = await tokenManager.getToken('wecom', 'corpId', 'corpSecret');
      expect(token).toBe('wecom-token-456');
      expect(mockFetch).toHaveBeenCalledOnce();
      // Check URL contains corpid param
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('corpid=corpId');
    });

    it('throws on wecom API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ errcode: 40013, errmsg: 'invalid corpid' }),
      });

      await expect(tokenManager.getToken('wecom', 'bad', 'bad'))
        .rejects.toThrow('invalid corpid');
    });
  });

  describe('getToken - DingTalk', () => {
    it('throws because dingtalk uses sessionWebhook', async () => {
      await expect(tokenManager.getToken('dingtalk', 'app', 'secret'))
        .rejects.toThrow('DingTalk does not use token-based auth');
    });
  });

  describe('invalidate', () => {
    it('forces re-fetch after invalidation', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            code: 0,
            tenant_access_token: 'old-token',
            expire: 7200,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            code: 0,
            tenant_access_token: 'new-token',
            expire: 7200,
          }),
        });

      const token1 = await tokenManager.getToken('feishu', 'app1', 'secret1');
      expect(token1).toBe('old-token');

      tokenManager.invalidate('feishu', 'app1');

      const token2 = await tokenManager.getToken('feishu', 'app1', 'secret1');
      expect(token2).toBe('new-token');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('clear', () => {
    it('clears all cached tokens', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            code: 0,
            tenant_access_token: 'token-a',
            expire: 7200,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            code: 0,
            tenant_access_token: 'token-b',
            expire: 7200,
          }),
        });

      await tokenManager.getToken('feishu', 'app1', 'secret1');
      expect(mockFetch).toHaveBeenCalledTimes(1);

      tokenManager.clear();

      await tokenManager.getToken('feishu', 'app1', 'secret1');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});
