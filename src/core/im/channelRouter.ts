/**
 * IMChannelRouter — Core integration for Phase 2 IM independent channel
 *
 * Flow: InboundMessage → AuthGate → SessionMapper → agentLoop → StreamingReply
 *
 * This router handles IM messages that target channels (not triggers).
 * It is registered as a listener on the 'im-inbound-event' Tauri event,
 * alongside the trigger engine's own IM listener.
 */

import { useIMChannelStore } from '../../stores/imChannelStore';
import { useChatStore } from '../../stores/chatStore';
import { runAgentLoop } from '../agent/agentLoop';
import type { NormalizedIMMessage } from './inboundRouter';
import { resolveCapability, getCallbacksForLevel } from './authGate';
import { sessionMapper } from './sessionMapper';
import { sendThinking, sendFinal, addProcessingReaction } from './streamingReply';
import type { AbuMessage } from './adapters/types';
import type { IMChannel, IMCapabilityLevel } from '../../types/imChannel';
import { tokenManager } from './tokenManager';
import { consumeTriggerContext } from './triggerContextCache';

const MAX_CONCURRENT_IM = 5;
/** Maximum time (ms) to wait for agentLoop before aborting */
const AGENT_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

class IMChannelRouter {
  private runningCount = 0;
  private queuedMessages: { message: NormalizedIMMessage; channelId: string }[] = [];
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  /** Track recently processed message IDs with timestamps for TTL-based dedup */
  private recentMessageIds = new Map<string, number>();

  async start() {
    // IM inbound events are dispatched by inboundDispatcher (single dispatcher pattern).
    // channelRouter no longer listens directly — it receives pre-parsed messages
    // via dispatchMessage() when no trigger matched.

    // Periodic session cleanup (every 5 minutes)
    this.cleanupInterval = setInterval(() => {
      sessionMapper.cleanup();
      // Purge only expired dedup entries (30-min TTL), not full clear
      const now = Date.now();
      const DEDUP_TTL_MS = 30 * 60 * 1000;
      for (const [key, ts] of this.recentMessageIds) {
        if (now - ts > DEDUP_TTL_MS) this.recentMessageIds.delete(key);
      }
    }, 5 * 60 * 1000);

    console.log('[IMChannel] Router started');
  }

  stop() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.queuedMessages = [];
    this.runningCount = 0;
    this.recentMessageIds.clear();
    console.log('[IMChannel] Router stopped');
  }

  /**
   * Called by inboundDispatcher when no trigger matched the message.
   * Accepts a pre-parsed NormalizedIMMessage.
   */
  dispatchMessage(message: NormalizedIMMessage): void {
    this.handleMessage(message);
  }

  private handleMessage(message: NormalizedIMMessage) {
    // Dedup: prefer messageId (stable ID) over content-based key
    const dedupKey = message.replyContext.messageId
      ? `${message.platform}:${message.replyContext.messageId}`
      : `${message.platform}:${message.chatId}:${message.senderId}:${message.text}`;
    const now = Date.now();
    const DEDUP_TTL_MS = 30 * 60 * 1000; // 30 minutes
    const seenAt = this.recentMessageIds.get(dedupKey);
    if (seenAt !== undefined && now - seenAt < DEDUP_TTL_MS) {
      console.log('[IMChannel] Duplicate message skipped');
      return;
    }
    this.recentMessageIds.set(dedupKey, now);

    // Find matching enabled channel for this platform
    const store = useIMChannelStore.getState();
    const channels = store.getChannelsByPlatform(message.platform).filter((c) => c.enabled);
    if (channels.length === 0) return;

    const channel = channels[0];

    // Response mode filter: in group chats, check if @mention is required
    if (!message.isDirect && channel.responseMode !== 'all_messages' && !message.isMention) {
      return; // Group message without @mention, skip silently
    }

    // Auth check
    const authResult = resolveCapability(message.senderId, channel);
    if (!authResult.allowed) {
      console.log(`[IMChannel] Auth denied for ${message.senderId}: ${authResult.reason}`);
      return;
    }

    // Concurrency check
    if (this.runningCount >= MAX_CONCURRENT_IM) {
      console.log('[IMChannel] Concurrency limit reached, queueing message');
      this.queuedMessages.push({ message, channelId: channel.id });
      // Best-effort: notify user they're in queue
      const queuePos = this.queuedMessages.length;
      const queueMsg: AbuMessage = {
        content: `收到！当前有 ${this.runningCount} 个请求正在处理，你的请求已排队（第 ${queuePos} 位），请稍候。`,
      };
      sendThinking(message.platform, message.replyContext)
        .then((h) => sendFinal(h, queueMsg))
        .catch(() => {});
      return;
    }

    this.processMessage(message, channel, authResult.capability);
  }

  private async processMessage(
    message: NormalizedIMMessage,
    channel: IMChannel,
    capability: IMCapabilityLevel,
  ) {
    this.runningCount++;
    let removeReaction: (() => Promise<void>) | null = null;

    try {
      // 1. Session resolution
      const resolveResult = sessionMapper.resolve(message, channel, capability);
      const { session, isRecovered, hasRecoverableSession, recoverableContext } = resolveResult;

      // 1b. Async user name resolution (non-blocking)
      if (resolveResult.isNew && message.platform === 'feishu' && message.senderId) {
        this.resolveFeishuUserName(message.senderId, channel, session.conversationId, session.key)
          .catch(() => {});
      }

      // 2. Send thinking acknowledgment (or recovery/hint messages)
      let replyHandle;

      if (isRecovered) {
        // Send recovery confirmation
        const confirmMsg: AbuMessage = {
          content: `已恢复上次对话上下文（${recoverableContext ?? ''}）。请继续。`,
        };
        replyHandle = await sendThinking(message.platform, message.replyContext);
        await sendFinal(replyHandle, confirmMsg);
        useIMChannelStore.getState().setChannelStatus(channel.id, 'connected');
        console.log(`[IMChannel] Recovered session for ${message.senderName}`);
        return; // "继续上次" is not a real question — just confirm and wait for next message
      }

      if (hasRecoverableSession) {
        // Hint the user that they can recover
        const hintMsg: AbuMessage = {
          content: `上一个话题已结束。回复"继续上次"可恢复上下文，或直接描述新的问题。`,
        };
        // Send hint as a side-effect, don't block main flow
        sendThinking(message.platform, message.replyContext)
          .then((h) => sendFinal(h, hintMsg))
          .catch(() => {});
      }

      // Add processing indicator: emoji reaction for Feishu/Slack, thinking message for others
      const adapter = (await import('./adapters/registry')).getAdapter(message.platform);

      if (adapter?.config.supportsMessageUpdate) {
        // Feishu/Slack: add emoji reaction as processing indicator
        removeReaction = await addProcessingReaction(message.platform, message.replyContext);
        replyHandle = {
          platform: message.platform,
          supportsUpdate: true,
          replyContext: message.replyContext,
        };
      } else {
        replyHandle = await sendThinking(message.platform, message.replyContext);
      }

      // 3. Run agent with timeout (agentLoop adds the user message internally)

      // Inject trigger context if a trigger recently processed a message in this chat
      let userText = message.text;
      if (resolveResult.isNew) {
        const triggerCtx = consumeTriggerContext(message.chatId);
        if (triggerCtx) {
          userText = `${message.text}\n\n[上下文] 触发器「${triggerCtx.triggerName}」刚才在这个群处理了一条消息，结果如下：\n${triggerCtx.summary}\n\n用户可能在追问上述触发器的处理结果，请结合这个上下文回答。`;
          console.log(`[IMChannel] Injected trigger context from "${triggerCtx.triggerName}" for chat ${message.chatId}`);
        }
      }

      const callbacks = getCallbacksForLevel(capability);
      await this.runWithTimeout(
        runAgentLoop(session.conversationId, userText, {
          commandConfirmCallback: callbacks.commandConfirmCallback,
          filePermissionCallback: callbacks.filePermissionCallback,
          blockedTools: ['request_workspace'],
          imContext: {
            platform: message.platform,
            workspacePath: channel.workspacePaths[0] ?? null,
            capability,
          },
        }),
        AGENT_TIMEOUT_MS,
      );

      // 5. Extract and send reply
      const lastAIContent = this.extractLastAIReply(session.conversationId);
      if (lastAIContent) {
        const replyMessage: AbuMessage = {
          content: lastAIContent,
          footer: `Abu AI · ${new Date().toLocaleString('zh-CN')}`,
        };
        const result = await sendFinal(replyHandle, replyMessage);
        if (!result.success) {
          console.warn(`[IMChannel] Reply send failed: ${result.error}`);
        }
      } else {
        console.warn(`[IMChannel] No AI reply found for conversation ${session.conversationId}`);
      }

      // Clear channel error on success
      useIMChannelStore.getState().setChannelStatus(channel.id, 'connected');
      console.log(`[IMChannel] Completed: ${message.senderName} in ${message.platform}`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[IMChannel] Error processing message:`, errorMsg);

      // Write error to channel store so UI can display it
      useIMChannelStore.getState().setChannelStatus(channel.id, 'error', errorMsg);

      // Best-effort error reply to user
      this.sendErrorReply(message, errorMsg).catch(() => {});
    } finally {
      // Remove processing reaction (emoji) if it was added
      if (removeReaction) {
        removeReaction().catch(() => {});
      }
      this.runningCount--;
      this.processQueue();
    }
  }

  /**
   * Wrap a promise with a timeout. Rejects with a clear message if exceeded.
   */
  private runWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Agent timed out after ${ms / 1000}s`)), ms);
      promise.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  }

  /**
   * Best-effort: try to notify the user that an error occurred.
   */
  private async sendErrorReply(message: NormalizedIMMessage, error: string) {
    const truncated = error.length > 100 ? error.slice(0, 100) + '...' : error;
    const errorMessage: AbuMessage = {
      content: `Abu 处理出错: ${truncated}`,
    };
    const handle = { platform: message.platform, supportsUpdate: false, replyContext: message.replyContext };
    await sendFinal(handle, errorMessage);
  }

  private processQueue() {
    if (this.queuedMessages.length === 0 || this.runningCount >= MAX_CONCURRENT_IM) return;

    const next = this.queuedMessages.shift()!;
    const store = useIMChannelStore.getState();
    const channel = store.channels[next.channelId];
    if (!channel || !channel.enabled) return;

    const authResult = resolveCapability(next.message.senderId, channel);
    if (!authResult.allowed) return;

    this.processMessage(next.message, channel, authResult.capability);
  }

  /**
   * Resolve Feishu user's display name via API and update session/conversation title.
   */
  private async resolveFeishuUserName(
    openId: string,
    channel: IMChannel,
    conversationId: string,
    sessionKey: string,
  ) {
    try {
      const token = await tokenManager.getToken('feishu', channel.appId, channel.appSecret);
      const { FeishuAdapter } = await import('./adapters/feishu');
      const adapter = new FeishuAdapter();
      const name = await adapter.resolveUserName(token, openId);
      if (!name) return;

      // Update session userName
      const store = useIMChannelStore.getState();
      const session = store.sessions[sessionKey];
      if (session) {
        store.upsertSession(sessionKey, { ...session, userName: name });
      }

      // Update conversation title
      const chatStore = useChatStore.getState();
      const conv = chatStore.conversations[conversationId];
      if (conv) {
        const chatName = session?.chatName ? ` · ${session.chatName}` : '';
        chatStore.renameConversation(conversationId, chatName ? `${name}${chatName}` : name);
      }

      console.log(`[IMChannel] Resolved Feishu user name: ${openId} → ${name}`);
    } catch (err) {
      console.warn(`[IMChannel] Failed to resolve user name for ${openId}:`, err);
    }
  }

  private extractLastAIReply(conversationId: string): string | null {
    const conv = useChatStore.getState().conversations[conversationId];
    if (!conv) return null;

    const lastAI = [...conv.messages].reverse().find((m) => m.role === 'assistant');
    if (!lastAI) return null;

    if (typeof lastAI.content === 'string') return lastAI.content;

    // Multimodal content
    return (lastAI.content as { type: string; text?: string }[])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');
  }
}

export const imChannelRouter = new IMChannelRouter();
