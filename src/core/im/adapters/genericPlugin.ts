/**
 * GenericPluginAdapter — Manifest-driven IM adapter for external plugins
 *
 * Sends messages and replies using API config from the plugin manifest.
 * No platform-specific code — everything is driven by JSON config.
 */

import { BaseAdapter } from './base';
import type { AdapterConfig, AbuMessage, MessageColor, DirectReplyContext } from './types';
import { getTauriFetch } from '../../llm/tauriFetch';
import type { PluginManifestFile } from '../pluginLoader';

export class GenericPluginAdapter extends BaseAdapter {
  readonly config: AdapterConfig;
  private manifestConfig: PluginManifestFile | null = null;
  private _userConfig: Record<string, unknown> = {};

  constructor(manifest: PluginManifestFile) {
    super();
    this.config = {
      platform: manifest.platform,
      displayName: manifest.displayName,
      maxLength: manifest.maxLength ?? 20000,
      chunkMode: manifest.chunkMode ?? 'newline',
      supportsMarkdown: manifest.capabilities.markdown,
      supportsCard: manifest.capabilities.card,
      supportsMessageUpdate: manifest.capabilities.messageUpdate,
    };
  }

  setManifest(manifest: PluginManifestFile): void {
    this.manifestConfig = manifest;
  }

  setUserConfig(config: Record<string, unknown>): void {
    this._userConfig = config;
  }

  getUserConfig(): Record<string, unknown> {
    return this._userConfig;
  }

  formatOutbound(message: AbuMessage): unknown {
    // Default: plain text for short, attachment for long (same as DChat pattern)
    if (message.content.length <= 3000 && !message.title) {
      return { text: message.content };
    }

    const colorMap: Record<MessageColor, string> = {
      success: '#36a64f',
      warning: '#ff9800',
      danger: '#e53935',
      info: '#2196f3',
    };

    return {
      text: message.title ?? '',
      attachments: [
        {
          title: message.title,
          text: message.content,
          color: message.color ? colorMap[message.color] : '#2196f3',
          ...(message.footer ? { footer: message.footer } : {}),
        },
      ],
    };
  }

  /**
   * Reply via platform API using manifest send config.
   * Supports Bearer token auth and Basic auth (clientId:clientSecret).
   */
  async replyToChat(
    token: string,
    context: DirectReplyContext,
    message: AbuMessage,
  ): Promise<{ messageId?: string }> {
    const sendConfig = this.manifestConfig?.send;
    if (!sendConfig) {
      throw new Error(`[${this.config.platform}] No send config in manifest`);
    }

    const authType = this.manifestConfig?.auth?.type;
    const botId = String(this._userConfig.botId ?? '');

    const vars: Record<string, string> = {
      token,
      chatId: context.chatId,
      content: message.content,
      title: message.title ?? '',
      botId,
    };

    // Build body from template
    const body = this.replaceTemplateVars(sendConfig.bodyTemplate, vars);

    // Build headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.replaceStringVars(sendConfig.headers ?? {}, vars),
    };

    // Auth: Basic (clientId:clientSecret) or Bearer token
    if (authType === 'basic') {
      const clientId = String(this._userConfig.clientId ?? '');
      const clientSecret = String(this._userConfig.clientSecret ?? '');
      headers['Authorization'] = `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
    } else if (!headers['Authorization']) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const f = await getTauriFetch();
    console.log(`[GenericPlugin] ${this.config.platform}: POST ${sendConfig.url} body=${JSON.stringify(body).slice(0, 200)}`);
    const resp = await f(sendConfig.url, {
      method: sendConfig.method ?? 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`[${this.config.platform}] Reply failed: HTTP ${resp.status}: ${text}`);
    }

    const data = await resp.json() as Record<string, unknown>;
    const code = data.code as number | undefined;
    if (code !== undefined && code !== 0) {
      const msg = data.msg ?? data.message ?? 'unknown';
      throw new Error(`[${this.config.platform}] Reply error: ${msg}`);
    }

    // Extract message ID from response
    let messageId: string | undefined;
    if (sendConfig.responseMessageIdPath) {
      messageId = String(this.extractPath(data, sendConfig.responseMessageIdPath) ?? '');
    }

    return { messageId };
  }

  private replaceTemplateVars(
    template: Record<string, unknown>,
    vars: Record<string, string>,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template)) {
      if (typeof value === 'string') {
        let replaced = value;
        for (const [varName, varValue] of Object.entries(vars)) {
          replaced = replaced.replace(new RegExp(`\\{\\{${varName}\\}\\}`, 'g'), varValue);
        }
        result[key] = replaced;
      } else if (value != null && typeof value === 'object' && !Array.isArray(value)) {
        result[key] = this.replaceTemplateVars(value as Record<string, unknown>, vars);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  private replaceStringVars(
    headers: Record<string, string>,
    vars: Record<string, string>,
  ): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      let replaced = value;
      for (const [varName, varValue] of Object.entries(vars)) {
        replaced = replaced.replace(new RegExp(`\\{\\{${varName}\\}\\}`, 'g'), varValue);
      }
      result[key] = replaced;
    }
    return result;
  }

  private extractPath(obj: Record<string, unknown>, path: string): unknown {
    const parts = path.split('.');
    let current: unknown = obj;
    for (const part of parts) {
      if (current == null || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }
}
