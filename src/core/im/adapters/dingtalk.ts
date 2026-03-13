/**
 * DingTalk Adapter
 *
 * Uses markdown message type.
 */

import { BaseAdapter } from './base';
import type { AdapterConfig, AbuMessage } from './types';

export class DingtalkAdapter extends BaseAdapter {
  readonly config: AdapterConfig = {
    platform: 'dingtalk',
    displayName: '钉钉',
    maxLength: 20000,
    chunkMode: 'newline',
    supportsMarkdown: true,
    supportsCard: false,
  };

  formatOutbound(message: AbuMessage): unknown {
    const title = message.title ?? 'Abu AI';
    let text = message.title ? `### ${message.title}\n\n` : '';
    text += message.content;
    if (message.footer) text += `\n\n---\n${message.footer}`;

    return {
      msgtype: 'markdown',
      markdown: { title, text },
    };
  }
}
