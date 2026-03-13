/**
 * BaseAdapter — Common logic for all IM adapters
 *
 * Handles: HTTP sending, auto-chunking, per-chunk retry with exponential backoff.
 * Subclasses only implement formatOutbound().
 */

import type { AdapterConfig, AbuMessage, IMAdapter } from './types';

export abstract class BaseAdapter implements IMAdapter {
  abstract readonly config: AdapterConfig;
  abstract formatOutbound(message: AbuMessage): unknown;

  /**
   * Send a single HTTP request.
   * Subclasses can override for platform-specific behavior.
   */
  async sendOutbound(
    webhookUrl: string,
    payload: unknown,
    headers?: Record<string, string>,
  ): Promise<void> {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`[${this.config.platform}] HTTP ${response.status}: ${text}`);
    }
  }

  /**
   * Split content into chunks that fit within maxLength.
   */
  chunkContent(content: string): string[] {
    const max = this.config.maxLength;
    if (content.length <= max) return [content];

    if (this.config.chunkMode === 'newline') {
      return this.chunkByNewline(content, max);
    }
    return this.chunkByLength(content, max);
  }

  /**
   * Paragraph-aware chunking — prefer breaking at newlines.
   * Falls back to chunkByLength for single lines that exceed maxLength.
   */
  private chunkByNewline(content: string, max: number): string[] {
    const chunks: string[] = [];
    let current = '';

    for (const line of content.split('\n')) {
      // Single line exceeds max → hard-cut then add as separate chunks
      if (line.length > max) {
        if (current) {
          chunks.push(current);
          current = '';
        }
        chunks.push(...this.chunkByLength(line, max));
        continue;
      }

      if ((current + '\n' + line).length > max && current) {
        chunks.push(current);
        current = line;
      } else {
        current = current ? current + '\n' + line : line;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  /**
   * Hard character-count chunking.
   */
  private chunkByLength(content: string, max: number): string[] {
    const chunks: string[] = [];
    const suffix = '\n\n...(续)';
    const effectiveMax = max - suffix.length;

    for (let i = 0; i < content.length; i += effectiveMax) {
      const chunk = content.slice(i, i + effectiveMax);
      const isLast = i + effectiveMax >= content.length;
      chunks.push(isLast ? chunk : chunk + suffix);
    }
    return chunks;
  }

  /**
   * Send a complete message with auto-chunking + per-chunk retry.
   *
   * @param webhookUrl - Target webhook URL
   * @param message - AbuMessage to send
   * @param headers - Optional custom HTTP headers (used by CustomAdapter)
   */
  async sendMessage(
    webhookUrl: string,
    message: AbuMessage,
    headers?: Record<string, string>,
  ): Promise<void> {
    const chunks = this.chunkContent(message.content);

    for (let i = 0; i < chunks.length; i++) {
      const chunkMessage: AbuMessage = {
        ...message,
        content: chunks[i],
        title: i === 0 ? message.title : undefined, // Title only on first chunk
      };
      const payload = this.formatOutbound(chunkMessage);

      // Per-chunk retry (3 attempts, exponential backoff)
      let lastError: Error | undefined;
      const delays = [3000, 8000, 20000];

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await this.sendOutbound(webhookUrl, payload, headers);
          lastError = undefined;
          break;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, delays[attempt]));
          }
        }
      }

      if (lastError) {
        throw new Error(
          `[${this.config.platform}] Chunk ${i + 1}/${chunks.length} failed after 3 retries: ${lastError.message}`,
        );
      }

      // Throttle between chunks to avoid platform rate limits
      if (i < chunks.length - 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
}
