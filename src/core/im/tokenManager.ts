/**
 * TokenManager — Manages API access tokens for IM platforms
 *
 * Each platform requires different auth flows:
 * - Feishu: POST app_id + app_secret → tenant_access_token (2h TTL)
 * - Slack: Bot token IS the appSecret (no exchange needed)
 * - WeCom: GET corpid + corpsecret → access_token (2h TTL)
 * - D-Chat: POST app_id + app_secret → access_token
 * - DingTalk: uses sessionWebhook (no token needed for reply)
 */

import type { IMPlatform } from '../../types/im';
import { getTauriFetch } from '../llm/tauriFetch';

interface CachedToken {
  token: string;
  expiresAt: number; // ms timestamp
}

/** Refresh tokens 10 minutes before expiry */
const REFRESH_BUFFER_MS = 10 * 60 * 1000;

class TokenManager {
  private cache = new Map<string, CachedToken>();

  /**
   * Get an access token for the given platform + credentials.
   * Returns cached token if still valid, otherwise fetches a new one.
   */
  async getToken(
    platform: IMPlatform,
    appId: string,
    appSecret: string,
  ): Promise<string> {
    const cacheKey = `${platform}:${appId}`;

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + REFRESH_BUFFER_MS) {
      return cached.token;
    }

    // Fetch new token
    const result = await this.fetchToken(platform, appId, appSecret);
    this.cache.set(cacheKey, result);
    return result.token;
  }

  /**
   * Invalidate cached token (e.g., on auth error).
   */
  invalidate(platform: IMPlatform, appId: string): void {
    this.cache.delete(`${platform}:${appId}`);
  }

  /**
   * Clear all cached tokens.
   */
  clear(): void {
    this.cache.clear();
  }

  private async fetchToken(
    platform: IMPlatform,
    appId: string,
    appSecret: string,
  ): Promise<CachedToken> {
    switch (platform) {
      case 'feishu':
        return this.fetchFeishuToken(appId, appSecret);
      case 'slack':
        return this.fetchSlackToken(appSecret);
      case 'wecom':
        return this.fetchWecomToken(appId, appSecret);
      case 'dchat':
        return this.fetchDchatToken(appId, appSecret);
      case 'dingtalk':
        // DingTalk uses sessionWebhook, not API token
        throw new Error('DingTalk does not use token-based auth for reply');
      default:
        throw new Error(`Unsupported platform for token auth: ${platform}`);
    }
  }

  /**
   * Feishu: tenant_access_token
   * POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal
   * Response: { tenant_access_token, expire }  (expire is seconds, typically 7200)
   */
  private async fetchFeishuToken(appId: string, appSecret: string): Promise<CachedToken> {
    const f = await getTauriFetch();
    const resp = await f(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      },
    );

    if (!resp.ok) {
      throw new Error(`[Feishu] Token fetch failed: HTTP ${resp.status}`);
    }

    const data = await resp.json() as {
      code?: number;
      msg?: string;
      tenant_access_token?: string;
      expire?: number;
    };

    if (data.code !== 0 || !data.tenant_access_token) {
      throw new Error(`[Feishu] Token error: ${data.msg ?? 'unknown'}`);
    }

    return {
      token: data.tenant_access_token,
      expiresAt: Date.now() + (data.expire ?? 7200) * 1000,
    };
  }

  /**
   * Slack: Bot token is the appSecret itself (OAuth Bot Token: xoxb-...)
   * No exchange needed — return immediately with long TTL.
   */
  private async fetchSlackToken(appSecret: string): Promise<CachedToken> {
    return {
      token: appSecret,
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000, // Never expires
    };
  }

  /**
   * WeCom: access_token
   * GET https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=ID&corpsecret=SECRET
   * Response: { errcode, errmsg, access_token, expires_in }  (expires_in typically 7200)
   */
  private async fetchWecomToken(corpId: string, corpSecret: string): Promise<CachedToken> {
    const f = await getTauriFetch();
    const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(corpSecret)}`;
    const resp = await f(url);

    if (!resp.ok) {
      throw new Error(`[WeCom] Token fetch failed: HTTP ${resp.status}`);
    }

    const data = await resp.json() as {
      errcode?: number;
      errmsg?: string;
      access_token?: string;
      expires_in?: number;
    };

    if (data.errcode !== 0 || !data.access_token) {
      throw new Error(`[WeCom] Token error: ${data.errmsg ?? 'unknown'}`);
    }

    return {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000,
    };
  }

  /**
   * D-Chat: access_token
   * POST internal API with app_id + app_secret
   * Actual endpoint depends on internal infra — using placeholder URL.
   * Users can configure base URL in channel settings if needed.
   */
  private async fetchDchatToken(appId: string, appSecret: string): Promise<CachedToken> {
    const f = await getTauriFetch();
    const resp = await f(
      'https://dchat-api.xiaojukeji.com/open-apis/auth/v1/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      },
    );

    if (!resp.ok) {
      throw new Error(`[D-Chat] Token fetch failed: HTTP ${resp.status}`);
    }

    const data = await resp.json() as {
      code?: number;
      msg?: string;
      access_token?: string;
      expire?: number;
    };

    if (data.code !== 0 || !data.access_token) {
      throw new Error(`[D-Chat] Token error: ${data.msg ?? 'unknown'}`);
    }

    return {
      token: data.access_token,
      expiresAt: Date.now() + (data.expire ?? 7200) * 1000,
    };
  }
}

export const tokenManager = new TokenManager();
