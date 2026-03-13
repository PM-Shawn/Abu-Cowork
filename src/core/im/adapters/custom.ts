/**
 * Custom HTTP Adapter
 *
 * Sends raw JSON with AbuMessage fields.
 * Supports custom headers (e.g. Authorization) passed via sendMessage.
 */

import { BaseAdapter } from './base';
import type { AdapterConfig, AbuMessage } from './types';

export class CustomAdapter extends BaseAdapter {
  readonly config: AdapterConfig = {
    platform: 'custom',
    displayName: '自定义 HTTP',
    maxLength: 100000,
    chunkMode: 'length',
    supportsMarkdown: true,
    supportsCard: false,
  };

  formatOutbound(message: AbuMessage): unknown {
    return {
      title: message.title,
      content: message.content,
      color: message.color,
      footer: message.footer,
      timestamp: new Date().toISOString(),
    };
  }
}
