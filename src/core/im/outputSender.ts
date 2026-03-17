/**
 * OutputSender — Extract AI results + build message + dispatch to IM adapter
 *
 * Flow: extractAIResponse → fill context → template replace (if needed) → send via adapter
 */

import { useChatStore } from '../../stores/chatStore';
import { useIMChannelStore } from '../../stores/imChannelStore';
import { getAdapter } from './adapters/registry';
import type { AbuMessage, OutputContext } from './adapters/types';
import type { TriggerOutput, OutputPlatform, OutputExtractMode } from '../../types/trigger';
import type { IMReplyContext } from '../../types/im';
import type { MessageContent } from '../../types';
import { tokenManager } from './tokenManager';

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
   * Supports 'webhook' (HTTP push) and 'im_channel' (via IM channel's API) targets.
   */
  async send(
    output: TriggerOutput,
    message: AbuMessage,
    replyContext?: IMReplyContext,
    receiveIdType?: 'chat_id' | 'open_id',
  ): Promise<{ success: boolean; error?: string }> {
    // im_channel: send via the IM channel's API credentials
    if (output.target === 'im_channel') {
      return this.sendViaIMChannel(output, message, replyContext, receiveIdType);
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
   * Send via IM channel — uses the channel's credentials and platform API.
   * Determines target chat from outputChatId, replyContext, or channel config.
   */
  private async sendViaIMChannel(
    output: TriggerOutput,
    message: AbuMessage,
    replyContext?: IMReplyContext,
    receiveIdType?: 'chat_id' | 'open_id',
  ): Promise<{ success: boolean; error?: string }> {
    const channelId = output.outputChannelId;
    if (!channelId) {
      return { success: false, error: 'No output channel ID configured' };
    }

    const store = useIMChannelStore.getState();
    const channel = store.channels[channelId];
    if (!channel) {
      return { success: false, error: `IM channel not found: ${channelId}` };
    }

    const { platform, appId, appSecret } = channel;
    const adapter = getAdapter(platform);
    if (!adapter) {
      return { success: false, error: `Unknown platform: ${platform}` };
    }

    // Build target list from outputChatIds + outputUserIds
    const targets: { id: string; receiveIdType?: 'chat_id' | 'open_id' }[] = [];

    if (output.outputChatIds) {
      for (const id of output.outputChatIds.split(',').map((s) => s.trim()).filter(Boolean)) {
        targets.push({ id, receiveIdType: 'chat_id' });
      }
    }
    if (output.outputUserIds) {
      for (const id of output.outputUserIds.split(',').map((s) => s.trim()).filter(Boolean)) {
        targets.push({ id, receiveIdType: 'open_id' });
      }
    }

    // Single target passed directly (e.g. from scheduler)
    if (targets.length === 0 && output.outputChatId) {
      targets.push({ id: output.outputChatId, receiveIdType: receiveIdType ?? 'chat_id' });
    }

    // Fallback: reply to source chat (for IM triggers)
    if (targets.length === 0) {
      // DingTalk: use sessionWebhook
      if (platform === 'dingtalk' && replyContext?.sessionWebhook) {
        try {
          await adapter.sendMessage(replyContext.sessionWebhook, message);
          return { success: true };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      }

      const fallbackChatId = this.extractChatIdFromReplyContext(replyContext);
      if (fallbackChatId) {
        targets.push({ id: fallbackChatId, receiveIdType: 'chat_id' });
      }
    }

    if (targets.length === 0) {
      return { success: false, error: 'No target chat/user ID available' };
    }

    if (!adapter.replyToChat) {
      return { success: false, error: `Platform ${platform} does not support API-based message sending` };
    }

    // Send to all targets
    try {
      const token = await tokenManager.getToken(platform, appId, appSecret);
      const results = await Promise.allSettled(
        targets.map((t) =>
          adapter.replyToChat!(token, { chatId: t.id, receiveIdType: t.receiveIdType }, message)
        )
      );

      const failures = results.filter((r) => r.status === 'rejected');
      if (failures.length === 0) {
        return { success: true };
      }
      const firstError = (failures[0] as PromiseRejectedResult).reason;
      const errorMsg = firstError instanceof Error ? firstError.message : String(firstError);
      if (errorMsg.includes('401') || errorMsg.includes('token') || errorMsg.includes('auth')) {
        tokenManager.invalidate(platform, appId);
      }
      return {
        success: failures.length < targets.length, // partial success
        error: `${targets.length - failures.length}/${targets.length} sent. Error: ${errorMsg}`,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (errorMsg.includes('401') || errorMsg.includes('token') || errorMsg.includes('auth')) {
        tokenManager.invalidate(platform, appId);
      }
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Extract chat ID from reply context (unified field)
   */
  private extractChatIdFromReplyContext(replyContext?: IMReplyContext): string | undefined {
    return replyContext?.chatId;
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
