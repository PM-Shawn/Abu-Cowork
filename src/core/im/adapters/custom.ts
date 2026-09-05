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

  /**
   * A free-form JSON envelope, so this is the one adapter that can carry
   * `metadata` — which is where an unattended run's structured ending lives
   * (batch 8, F8-3). Additive: `content` stays byte-identical to what a
   * consumer received before, and the key is simply absent when there is no
   * metadata, so an existing `JSON.parse(body.content)` reader is untouched.
   */
  formatOutbound(message: AbuMessage): unknown {
    return {
      title: message.title,
      content: message.content,
      color: message.color,
      footer: message.footer,
      ...(message.metadata ? { metadata: message.metadata } : {}),
      timestamp: new Date().toISOString(),
    };
  }
}
