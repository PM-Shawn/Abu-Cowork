/**
 * D-Chat Adapter — 滴滴内部 IM
 *
 * Short messages: plain text
 * Long messages: attachment format with color sidebar
 */

import { BaseAdapter } from './base';
import type { AdapterConfig, AbuMessage, MessageColor, DirectReplyContext } from './types';
import { getTauriFetch } from '../../llm/tauriFetch';

export class DchatAdapter extends BaseAdapter {
  readonly config: AdapterConfig = {
    platform: 'dchat',
    displayName: 'D-Chat',
    maxLength: 20000,
    chunkMode: 'newline',
    supportsMarkdown: true,
    supportsCard: true,
  };

  formatOutbound(message: AbuMessage): unknown {
    // Short messages use plain text
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
   * Reply via D-Chat API (message.send).
   *
   * Uses the vchannel (virtual channel) concept for group/DM targeting.
   * Token is the app access_token.
   *
   * Note: D-Chat is an internal platform. The API endpoint is a placeholder
   * and may need adjustment based on actual deployment.
   */
  async replyToChat(
    token: string,
    context: DirectReplyContext,
    message: AbuMessage,
  ): Promise<{ messageId?: string }> {
    const payload = this.formatOutbound(message);

    const body = {
      vchannel_id: context.chatId,
      ...(payload as Record<string, unknown>),
    };

    const f = await getTauriFetch();
    const resp = await f(
      'https://dchat-api.xiaojukeji.com/open-apis/message/v1/send',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      },
    );

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`[D-Chat] Reply failed: HTTP ${resp.status}: ${text}`);
    }

    const data = await resp.json() as { code?: number; msg?: string; data?: { message_id?: string } };
    if (data.code !== 0) {
      throw new Error(`[D-Chat] Reply error: ${data.msg ?? 'unknown'}`);
    }

    return { messageId: data.data?.message_id };
  }
}
