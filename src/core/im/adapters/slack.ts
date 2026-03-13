/**
 * Slack Adapter
 *
 * Uses Block Kit format. Converts Markdown to Slack mrkdwn.
 *
 * Known limitations (Phase 1 — to be addressed as needed):
 * - Tables not supported, rendered as-is
 * - Nested lists get flattened
 * - Image syntax not supported
 */

import { BaseAdapter } from './base';
import type { AdapterConfig, AbuMessage, DirectReplyContext } from './types';
import { getTauriFetch } from '../../llm/tauriFetch';

export class SlackAdapter extends BaseAdapter {
  readonly config: AdapterConfig = {
    platform: 'slack',
    displayName: 'Slack',
    maxLength: 3000, // Block Kit section limit with margin
    chunkMode: 'newline',
    supportsMarkdown: false, // Slack uses mrkdwn, not standard Markdown
    supportsCard: true,
    supportsMessageUpdate: true,
  };

  formatOutbound(message: AbuMessage): unknown {
    const blocks: unknown[] = [];

    if (message.title) {
      blocks.push({
        type: 'header',
        text: { type: 'plain_text', text: message.title },
      });
    }

    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: this.toMrkdwn(message.content) },
    });

    if (message.footer) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: message.footer }],
      });
    }

    return { blocks };
  }

  /**
   * Convert Markdown → Slack mrkdwn
   */
  private toMrkdwn(md: string): string {
    return (
      md
        // Headings → bold
        .replace(/^#{1,3} (.+)$/gm, '*$1*')
        // **bold** → *bold*
        .replace(/\*\*(.+?)\*\*/g, '*$1*')
        // [text](url) → <url|text>
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')
        // ~~strikethrough~~ → ~strikethrough~
        .replace(/~~(.+?)~~/g, '~$1~')
        // - list → • list
        .replace(/^- /gm, '• ')
    );
    // > blockquote stays the same (Slack also uses >)
  }

  /**
   * Reply via Slack Web API (chat.postMessage).
   *
   * Uses thread_ts for threading if available.
   * Bot token (xoxb-...) is passed as the access token.
   *
   * API docs: https://api.slack.com/methods/chat.postMessage
   */
  async replyToChat(
    token: string,
    context: DirectReplyContext,
    message: AbuMessage,
  ): Promise<{ messageId?: string }> {
    const payload = this.formatOutbound(message) as { blocks: unknown[] };

    const body: Record<string, unknown> = {
      channel: context.chatId,
      blocks: payload.blocks,
    };
    if (context.threadTs) {
      body.thread_ts = context.threadTs;
    }

    const f = await getTauriFetch();
    const resp = await f('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`[Slack] Reply failed: HTTP ${resp.status}: ${text}`);
    }

    const data = await resp.json() as { ok?: boolean; error?: string; ts?: string };
    if (!data.ok) {
      throw new Error(`[Slack] Reply error: ${data.error ?? 'unknown'}`);
    }

    return { messageId: data.ts };
  }
}
