/**
 * OutputSender — Extract AI results + build message + dispatch to IM adapter
 *
 * Flow: extractAIResponse → fill context → template replace (if needed) → send via adapter
 */

import { useChatStore } from '../../stores/chatStore';
import { getAdapter } from './adapters/registry';
import type { AbuMessage, OutputContext } from './adapters/types';
import type { TriggerOutput, OutputPlatform, OutputExtractMode, IMReplyContext } from '../../types/trigger';
import type { MessageContent } from '../../types';

/** Extract plain text from message content (string or multimodal array) */
function contentToString(content: string | MessageContent[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

class OutputSender {
  /**
   * Extract AI response text from conversation
   */
  extractAIResponse(conversationId: string, mode: OutputExtractMode): string {
    const conversation = useChatStore.getState().conversations[conversationId];
    const messages = conversation?.messages ?? [];

    switch (mode) {
      case 'last_message': {
        const lastAI = [...messages].reverse().find((m) => m.role === 'assistant');
        return lastAI ? contentToString(lastAI.content) : '(无结果)';
      }
      case 'full': {
        return messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => `**${m.role === 'user' ? '事件' : 'Abu'}**: ${contentToString(m.content)}`)
          .join('\n\n');
      }
      case 'custom_template': {
        // Template mode: return raw AI response, template replacement happens in buildMessage
        const lastAI = [...messages].reverse().find((m) => m.role === 'assistant');
        return lastAI ? contentToString(lastAI.content) : '(无结果)';
      }
    }
  }

  /**
   * Build AbuMessage from conversation results
   *
   * 1. extractAIResponse → get raw AI reply
   * 2. Fill context.aiResponse
   * 3. If template mode → variable replacement
   * 4. Assemble AbuMessage
   */
  buildMessage(
    conversationId: string,
    output: TriggerOutput,
    context: OutputContext,
  ): AbuMessage {
    // Step 1: Extract AI response
    const aiResponse = this.extractAIResponse(conversationId, output.extractMode);
    // Step 2: Fill into context (for template variables)
    context.aiResponse = aiResponse;

    // Step 3: Determine final content
    let content: string;
    if (output.extractMode === 'custom_template' && output.customTemplate) {
      content = this.replaceVariables(output.customTemplate, context);
    } else {
      content = aiResponse;
    }

    // Step 4: Assemble
    return {
      content,
      title: context.triggerName,
      color: 'info',
      footer: `Abu AI · ${context.timestamp}`,
    };
  }

  /**
   * Send result to target platform.
   * Supports both 'webhook' (Phase 1A) and 'reply_source' (Phase 1B) targets.
   * Retry logic is at per-chunk level in BaseAdapter.sendMessage,
   * no whole-message retry here to avoid duplicate chunks.
   */
  async send(
    output: TriggerOutput,
    message: AbuMessage,
    replyContext?: IMReplyContext,
  ): Promise<{ success: boolean; error?: string }> {
    // reply_source: use the IM platform's reply mechanism
    if (output.target === 'reply_source') {
      return this.sendReplySource(message, replyContext);
    }

    // webhook: send to configured URL
    if (!output.platform || !output.webhookUrl) {
      return { success: false, error: 'Missing platform or webhookUrl' };
    }

    const adapter = getAdapter(output.platform);
    if (!adapter) {
      return { success: false, error: `Unknown platform: ${output.platform}` };
    }

    try {
      // Custom headers passed as sendMessage parameter (not via metadata)
      await adapter.sendMessage(output.webhookUrl, message, output.customHeaders);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Reply to the IM source that triggered this run.
   * Uses the platform's reply API via the stored replyContext.
   *
   * For Phase 1B, we reply via the same webhook mechanism (sending a new message).
   * Each platform's reply approach:
   * - DingTalk: use sessionWebhook (temporary webhook URL provided in callback)
   * - Others: use the adapter's sendMessage to the webhook URL
   *
   * Full platform reply APIs (POST to message send/reply endpoints with tokens)
   * will be added in Phase 2 when InboundAdapter has full API auth.
   */
  private async sendReplySource(
    message: AbuMessage,
    replyContext?: IMReplyContext,
  ): Promise<{ success: boolean; error?: string }> {
    if (!replyContext) {
      return { success: false, error: 'No reply context available (trigger may not be an IM source)' };
    }

    // DingTalk: sessionWebhook is a temporary URL that can be POSTed to directly
    if (replyContext.platform === 'dingtalk' && replyContext.sessionWebhook) {
      const adapter = getAdapter('dingtalk');
      if (!adapter) return { success: false, error: 'DingTalk adapter not found' };
      try {
        await adapter.sendMessage(replyContext.sessionWebhook, message);
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    // For other platforms, reply_source requires full API auth (Phase 2).
    // For now, return a clear error message.
    return {
      success: false,
      error: `reply_source for ${replyContext.platform} requires API auth (available in Phase 2). Use 'webhook' target for now.`,
    };
  }

  /**
   * Test push — verify webhook connectivity
   */
  async testSend(
    platform: OutputPlatform,
    webhookUrl: string,
    customHeaders?: Record<string, string>,
  ): Promise<{ success: boolean; error?: string }> {
    const adapter = getAdapter(platform);
    if (!adapter) return { success: false, error: `Unknown platform: ${platform}` };

    const testMessage: AbuMessage = {
      content: 'Abu AI 连接测试成功',
      title: '测试消息',
      color: 'success',
      footer: `Abu AI · ${new Date().toLocaleString('zh-CN')}`,
    };

    try {
      await adapter.sendMessage(webhookUrl, testMessage, customHeaders);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Template variable replacement
   */
  private replaceVariables(template: string, ctx: OutputContext): string {
    return template
      .replace(/\$TRIGGER_NAME/g, ctx.triggerName ?? '')
      .replace(/\$EVENT_SUMMARY/g, ctx.eventSummary ?? '')
      .replace(/\$AI_RESPONSE/g, ctx.aiResponse ?? '')
      .replace(/\$RUN_TIME/g, ctx.runTime ?? '')
      .replace(/\$TIMESTAMP/g, ctx.timestamp ?? '')
      .replace(/\$EVENT_DATA/g, ctx.eventData ?? '');
  }
}

export const outputSender = new OutputSender();
