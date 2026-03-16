/**
 * StreamingReply — Platform-dependent reply strategy
 *
 * Platforms with supportsMessageUpdate (Feishu, Slack):
 *   1. Send "thinking..." placeholder
 *   2. Periodically update message content while agent runs
 *   3. Send final result
 *
 * Platforms without (DingTalk, D-Chat, WeCom):
 *   1. Send "正在分析..." acknowledgment
 *   2. Wait for completion
 *   3. Send final result as new message
 *
 * Phase 3A: Token-based direct replies for all platforms (except DingTalk
 * which uses sessionWebhook). Falls back to degraded success if no token.
 */

import { getAdapter } from './adapters/registry';
import type { AbuMessage, DirectReplyContext } from './adapters/types';
import type { IMPlatform, IMReplyContext } from '../../types/im';
import { tokenManager } from './tokenManager';
import { useIMChannelStore } from '../../stores/imChannelStore';

export interface ReplyHandle {
  /** Platform */
  platform: IMPlatform;
  /** Whether this platform supports streaming updates */
  supportsUpdate: boolean;
  /** The placeholder message ID (for update-capable platforms) */
  placeholderMessageId?: string;
  /** Reply context from inbound message */
  replyContext: IMReplyContext;
}

/**
 * Build a DirectReplyContext from IMReplyContext for API-based reply.
 */
function toDirectReplyContext(replyCtx: IMReplyContext): DirectReplyContext | null {
  switch (replyCtx.platform) {
    case 'feishu':
      if (!replyCtx.chatId) return null;
      return { chatId: replyCtx.chatId, messageId: replyCtx.messageId };
    case 'slack':
      if (!replyCtx.channelId) return null;
      return { chatId: replyCtx.channelId, threadTs: replyCtx.threadTs };
    case 'wecom':
      if (!replyCtx.chatid) return null;
      return { chatId: replyCtx.chatid };
    case 'dchat':
      if (!replyCtx.vchannelId) return null;
      return { chatId: replyCtx.vchannelId };
    default:
      return null;
  }
}

/**
 * Find the channel's credentials for the given platform.
 * Returns { appId, appSecret } or null.
 */
function getChannelCredentials(platform: IMPlatform): { appId: string; appSecret: string } | null {
  const store = useIMChannelStore.getState();
  const channels = store.getChannelsByPlatform(platform).filter((c) => c.enabled);
  if (channels.length === 0) return null;
  const ch = channels[0];
  if (!ch.appId || !ch.appSecret) return null;
  return { appId: ch.appId, appSecret: ch.appSecret };
}

/**
 * Try to send a message via API token. Returns true if sent successfully.
 */
async function trySendViaApi(
  platform: IMPlatform,
  replyContext: IMReplyContext,
  message: AbuMessage,
): Promise<{ sent: boolean; messageId?: string; error?: string }> {
  const adapter = getAdapter(platform);
  if (!adapter?.replyToChat) {
    return { sent: false, error: 'adapter_no_reply' };
  }

  const directCtx = toDirectReplyContext(replyContext);
  if (!directCtx) {
    return { sent: false, error: 'no_reply_context' };
  }

  const creds = getChannelCredentials(platform);
  if (!creds) {
    return { sent: false, error: 'no_credentials' };
  }

  try {
    const token = await tokenManager.getToken(platform, creds.appId, creds.appSecret);
    const result = await adapter.replyToChat(token, directCtx, message);
    return { sent: true, messageId: result.messageId };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    // Invalidate token on auth errors so next attempt fetches a fresh one
    if (errorMsg.includes('401') || errorMsg.includes('token') || errorMsg.includes('auth')) {
      tokenManager.invalidate(platform, creds.appId);
    }
    return { sent: false, error: errorMsg };
  }
}

/**
 * Send an acknowledgment / thinking message.
 * Returns a handle for subsequent updates or final send.
 */
export async function sendThinking(
  platform: IMPlatform,
  replyContext: IMReplyContext,
  thinkingText?: string,
): Promise<ReplyHandle> {
  const adapter = getAdapter(platform);
  const supportsUpdate = adapter?.config.supportsMessageUpdate ?? false;
  const text = thinkingText ?? '收到，正在分析...';

  const handle: ReplyHandle = {
    platform,
    supportsUpdate,
    replyContext,
  };

  const msg: AbuMessage = { content: text };

  // 1. Try sessionWebhook (DingTalk)
  if (replyContext.sessionWebhook && adapter) {
    try {
      await adapter.sendMessage(replyContext.sessionWebhook, msg);
    } catch (err) {
      console.warn(`[StreamingReply] Thinking send failed (non-critical):`, err);
    }
    return handle;
  }

  // 2. Try API token reply
  const result = await trySendViaApi(platform, replyContext, msg);
  if (result.sent) {
    handle.placeholderMessageId = result.messageId;
  }

  return handle;
}

/**
 * Send the final result.
 *
 * Resolution order:
 * 1. sessionWebhook (DingTalk) — send directly
 * 2. API token reply (Feishu, Slack, WeCom, D-Chat) — via platform API
 * 3. Degraded success — reply stored in Abu conversation only
 */
export async function sendFinal(
  handle: ReplyHandle,
  message: AbuMessage,
): Promise<{ success: boolean; error?: string }> {
  const adapter = getAdapter(handle.platform);
  if (!adapter) {
    return { success: false, error: `Unknown platform: ${handle.platform}` };
  }

  // 1. DingTalk / any platform with sessionWebhook
  if (handle.replyContext.sessionWebhook) {
    try {
      await adapter.sendMessage(handle.replyContext.sessionWebhook, message);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // 2. API token reply
  const apiResult = await trySendViaApi(handle.platform, handle.replyContext, message);
  if (apiResult.sent) {
    return { success: true };
  }

  // 3. Degraded success — message is in Abu's conversation, just can't push to IM
  console.log(
    `[StreamingReply] No direct reply channel for ${handle.platform}. ` +
    `Reply stored in conversation only. Reason: ${apiResult.error}`,
  );
  return {
    success: true,
    error: `no_direct_reply:${handle.platform}:${apiResult.error}`,
  };
}

// ── Feishu Emoji Reaction (processing indicator) ──

const PROCESSING_EMOJI = 'Get'; // 飞书内置 "get" 表情

/**
 * Add a processing reaction (emoji) to the user's message.
 * Returns a cleanup function that removes the reaction.
 */
export async function addProcessingReaction(
  platform: IMPlatform,
  replyContext: IMReplyContext,
): Promise<(() => Promise<void>) | null> {
  if (platform !== 'feishu') return null;

  const messageId = replyContext.messageId;
  if (!messageId) return null;

  const creds = getChannelCredentials(platform);
  if (!creds) return null;

  try {
    const { getTauriFetch } = await import('../llm/tauriFetch');
    const f = await getTauriFetch();
    const token = await tokenManager.getToken(platform, creds.appId, creds.appSecret);

    const resp = await f(
      `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reactions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          reaction_type: { emoji_type: PROCESSING_EMOJI },
        }),
      },
    );

    if (!resp.ok) return null;

    const data = await resp.json() as {
      code?: number;
      data?: { reaction_id?: string };
    };

    if (data.code !== 0 || !data.data?.reaction_id) return null;

    const reactionId = data.data.reaction_id;

    // Return cleanup function
    return async () => {
      try {
        const freshToken = await tokenManager.getToken(platform, creds.appId, creds.appSecret);
        await f(
          `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reactions/${reactionId}`,
          {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${freshToken}` },
          },
        );
      } catch {
        // Best-effort: don't fail if reaction removal fails
      }
    };
  } catch {
    return null;
  }
}
