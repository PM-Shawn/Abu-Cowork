/**
 * WeCom (企业微信) Adapter
 *
 * Uses markdown message type. 4096 byte limit (not character).
 */

import { BaseAdapter } from './base';
import type { AdapterConfig, AbuMessage, DirectReplyContext } from './types';
import { getTauriFetch } from '../../llm/tauriFetch';

export class WecomAdapter extends BaseAdapter {
  readonly config: AdapterConfig = {
    platform: 'wecom',
    displayName: '企业微信',
    maxLength: 4096, // byte limit
    chunkMode: 'newline',
    supportsMarkdown: true,
    supportsCard: false,
  };

  formatOutbound(message: AbuMessage): unknown {
    let content = '';
    if (message.title) content += `### ${message.title}\n\n`;
    content += message.content;
    if (message.footer) content += `\n\n> ${message.footer}`;

    return {
      msgtype: 'markdown',
      markdown: { content },
    };
  }

  /**
   * Override chunking — WeCom counts bytes, not characters.
   */
  chunkContent(content: string): string[] {
    const maxBytes = this.config.maxLength;
    const encoder = new TextEncoder();

    if (encoder.encode(content).length <= maxBytes) return [content];

    const chunks: string[] = [];
    let current = '';

    for (const line of content.split('\n')) {
      const candidate = current ? current + '\n' + line : line;

      // Single line exceeds byte limit → hard byte-cut
      if (encoder.encode(line).length > maxBytes) {
        if (current) {
          chunks.push(current);
          current = '';
        }
        let segment = '';
        for (const char of line) {
          if (encoder.encode(segment + char).length > maxBytes - 20) {
            chunks.push(segment + '...');
            segment = char;
          } else {
            segment += char;
          }
        }
        if (segment) current = segment;
        continue;
      }

      if (encoder.encode(candidate).length > maxBytes && current) {
        chunks.push(current);
        current = line;
      } else {
        current = candidate;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  /**
   * Reply via WeCom API (appchat/send for group, message/send for individual).
   *
   * Uses the group chat API (appchat/send) which sends markdown to a group.
   * Token is the corp access_token.
   *
   * API docs: https://developer.work.weixin.qq.com/document/path/90248
   */
  async replyToChat(
    token: string,
    context: DirectReplyContext,
    message: AbuMessage,
  ): Promise<{ messageId?: string }> {
    const payload = this.formatOutbound(message) as { msgtype: string; markdown: { content: string } };

    const body = {
      chatid: context.chatId,
      ...payload,
    };

    const f = await getTauriFetch();
    const url = `https://qyapi.weixin.qq.com/cgi-bin/appchat/send?access_token=${encodeURIComponent(token)}`;
    const resp = await f(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`[WeCom] Reply failed: HTTP ${resp.status}: ${text}`);
    }

    const data = await resp.json() as { errcode?: number; errmsg?: string };
    if (data.errcode !== 0) {
      throw new Error(`[WeCom] Reply error: ${data.errmsg ?? 'unknown'}`);
    }

    return {};
  }
}
