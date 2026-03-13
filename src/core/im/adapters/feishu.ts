/**
 * Feishu (Lark) Adapter
 *
 * Uses interactive card messages with Markdown support.
 */

import { BaseAdapter } from './base';
import type { AdapterConfig, AbuMessage, MessageColor, DirectReplyContext } from './types';
import { getTauriFetch } from '../../llm/tauriFetch';

export class FeishuAdapter extends BaseAdapter {
  readonly config: AdapterConfig = {
    platform: 'feishu',
    displayName: '飞书',
    maxLength: 30000,
    chunkMode: 'newline',
    supportsMarkdown: true,
    supportsCard: true,
    supportsMessageUpdate: true,
  };

  formatOutbound(message: AbuMessage): unknown {
    const colorMap: Record<MessageColor, string> = {
      success: 'green',
      warning: 'orange',
      danger: 'red',
      info: 'blue',
    };

    return {
      msg_type: 'interactive',
      card: {
        header: message.title
          ? {
              title: { tag: 'plain_text', content: message.title },
              template: message.color ? colorMap[message.color] : 'blue',
            }
          : undefined,
        elements: [
          { tag: 'markdown', content: message.content },
          ...(message.footer
            ? [
                {
                  tag: 'note',
                  elements: [{ tag: 'plain_text', content: message.footer }],
                },
              ]
            : []),
        ],
      },
    };
  }

  /**
   * Reply via Feishu Open API.
   *
   * If messageId is provided, uses reply endpoint (threaded reply).
   * Otherwise, sends a new message to the chat.
   *
   * API docs:
   * - Send: POST /open-apis/im/v1/messages?receive_id_type=chat_id
   * - Reply: POST /open-apis/im/v1/messages/:message_id/reply
   */
  async replyToChat(
    token: string,
    context: DirectReplyContext,
    message: AbuMessage,
  ): Promise<{ messageId?: string }> {
    const card = this.formatOutbound(message);
    const body = {
      msg_type: 'interactive',
      content: JSON.stringify((card as { card: unknown }).card),
    };

    let url: string;
    let reqBody: unknown;

    if (context.messageId) {
      // Threaded reply
      url = `https://open.feishu.cn/open-apis/im/v1/messages/${context.messageId}/reply`;
      reqBody = body;
    } else {
      // New message to chat
      url = `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id`;
      reqBody = { ...body, receive_id: context.chatId };
    }

    const f = await getTauriFetch();
    const resp = await f(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(reqBody),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`[Feishu] Reply failed: HTTP ${resp.status}: ${text}`);
    }

    const data = await resp.json() as { code?: number; msg?: string; data?: { message_id?: string } };
    if (data.code !== 0) {
      throw new Error(`[Feishu] Reply error: ${data.msg ?? 'unknown'}`);
    }

    return { messageId: data.data?.message_id };
  }

  /**
   * Resolve a Feishu user's display name via Contact API.
   * GET /open-apis/contact/v3/users/:user_id?user_id_type=open_id
   * Caches results to avoid repeated API calls.
   */
  private nameCache = new Map<string, string>();

  async resolveUserName(token: string, openId: string): Promise<string | null> {
    const cached = this.nameCache.get(openId);
    if (cached) return cached;

    try {
      const f = await getTauriFetch();
      const resp = await f(
        `https://open.feishu.cn/open-apis/contact/v3/users/${openId}?user_id_type=open_id`,
        {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${token}` },
        },
      );

      if (!resp.ok) return null;

      const data = await resp.json() as {
        code?: number;
        data?: { user?: { name?: string; en_name?: string } };
      };

      if (data.code !== 0) return null;

      const name = data.data?.user?.name ?? data.data?.user?.en_name ?? null;
      if (name) this.nameCache.set(openId, name);
      return name;
    } catch {
      return null;
    }
  }
}
