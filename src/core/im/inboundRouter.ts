/**
 * InboundRouter — Parse platform-specific IM webhook payloads into normalized InboundMessage
 *
 * Each platform sends different JSON structures. This module normalizes them
 * into a common format that the trigger engine can process.
 */

import type { IMPlatform, IMReplyContext } from '../../types/im';
import { getIMPlugin } from './pluginRegistry';

/** Normalized inbound IM message */
export interface NormalizedIMMessage {
  /** Sender user ID (platform-specific) */
  senderId: string;
  /** Sender display name */
  senderName: string;
  /** Message text content */
  text: string;
  /** Whether Abu was @mentioned */
  isMention: boolean;
  /** Whether this is a direct/private message */
  isDirect: boolean;
  /** Chat/group ID */
  chatId: string;
  /** Chat/group name (if available) */
  chatName?: string;
  /** Platform identifier */
  platform: IMPlatform;
  /** Context needed to reply back */
  replyContext: IMReplyContext;
  /** Original raw payload for debugging */
  raw: unknown;
}

/**
 * Parse a raw IM platform webhook payload into a normalized message.
 * Returns null if the payload is not a user message (e.g. bot message, system event).
 */
export function parseInboundMessage(
  platform: string,
  payload: Record<string, unknown>,
): NormalizedIMMessage | null {
  // Built-in parsers
  switch (platform) {
    case 'feishu':
      return parseFeishu(payload);
    case 'dingtalk':
      return parseDingTalk(payload);
    case 'wecom':
      return parseWeCom(payload);
    case 'slack':
      return parseSlack(payload);
    case 'wechat':
      return parseWeChatILink(payload);
    default: {
      // Fallback: plugin-registered parser
      const plugin = getIMPlugin(platform);
      if (plugin) return plugin.parseInbound(payload);
      console.warn(`[InboundRouter] Unknown platform: ${platform}`);
      return null;
    }
  }
}

// ── Feishu ──

function parseFeishu(payload: Record<string, unknown>): NormalizedIMMessage | null {
  // Only handle new message events — ignore message_read, message_recalled, etc.
  const header = payload.header as Record<string, unknown> | undefined;
  const eventType = String(header?.event_type ?? '');
  if (eventType && eventType !== 'im.message.receive_v1') {
    console.log(`[InboundRouter] Feishu: ignoring event type "${eventType}"`);
    return null;
  }

  // Stale event filter: skip events older than 5 minutes (reconnect replay defense)
  const createTime = header?.create_time;
  if (createTime) {
    const createMs = Number(createTime);
    if (!isNaN(createMs)) {
      const ageMs = Date.now() - createMs;
      if (ageMs > 5 * 60 * 1000) {
        console.log(`[InboundRouter] Feishu: stale event skipped (age=${Math.round(ageMs / 1000)}s)`);
        return null;
      }
    }
  }

  // Feishu event callback format:
  // { event: { message: { chat_id, message_id, content, ... }, sender: { sender_id, ... } }, ... }
  const event = payload.event as Record<string, unknown> | undefined;
  if (!event) return null;

  const message = event.message as Record<string, unknown> | undefined;
  const sender = event.sender as Record<string, unknown> | undefined;
  if (!message || !sender) return null;

  // Parse content JSON (Feishu wraps text in JSON)
  let text: string;
  const contentStr = String(message.content ?? '');
  try {
    const content = JSON.parse(contentStr);
    text = String(content.text ?? '');
  } catch {
    text = contentStr;
  }

  if (!text) return null;

  const senderId = sender.sender_id as Record<string, string> | undefined;
  const uid = senderId?.open_id ?? senderId?.user_id ?? String(sender.sender_id ?? '');

  const chatId = String(message.chat_id ?? '');
  const messageId = String(message.message_id ?? '');
  const chatType = String(message.chat_type ?? '');

  // Check for @mention (Feishu mentions have specific format)
  // In Feishu group chats, the bot typically only receives messages where it's @mentioned.
  // Check: mentions array has entries, or text contains mention tags, or common bot names.
  const mentions = (event.message as Record<string, unknown>)?.mentions as { name?: string; id?: { open_id?: string } }[] | undefined;
  const hasMentions = mentions != null && mentions.length > 0;
  const isMention = hasMentions || /(@_user_\d+|@Abu|@abu|@阿布)/.test(text);
  const isDirect = chatType === 'p2p';

  // Clean mention tags from text
  const cleanText = text.replace(/@_user_\d+/g, '').trim();

  return {
    senderId: uid,
    senderName: String((sender as Record<string, unknown>).sender_name ?? uid),
    text: cleanText,
    isMention,
    isDirect,
    chatId,
    chatName: String((message as Record<string, unknown>).chat_name ?? ''),
    platform: 'feishu',
    replyContext: {
      platform: 'feishu',
      chatId,
      messageId,
    },
    raw: payload,
  };
}

// ── DingTalk ──

function parseDingTalk(payload: Record<string, unknown>): NormalizedIMMessage | null {
  // DingTalk robot callback format:
  // { text: { content }, senderNick, senderStaffId, conversationType, sessionWebhook, ... }
  const textObj = payload.text as Record<string, unknown> | undefined;
  const text = String(textObj?.content ?? payload.content ?? '');
  if (!text) return null;

  const senderId = String(payload.senderStaffId ?? payload.senderId ?? '');
  const senderNick = String(payload.senderNick ?? '');
  const isAtAll = payload.isAtAll === true;

  // conversationType: "1" = private, "2" = group
  const conversationType = String(payload.conversationType ?? '');
  const isDirect = conversationType === '1';

  // Check @mention from atUsers list
  const atUsers = payload.atUsers as { dingtalkId?: string }[] | undefined;
  const isMention = isAtAll || (atUsers?.length ?? 0) > 0;

  const sessionWebhook = String(payload.sessionWebhook ?? '');
  const conversationId = String(payload.conversationId ?? '');

  return {
    senderId,
    senderName: senderNick,
    text: text.trim(),
    isMention,
    isDirect,
    chatId: conversationId,
    platform: 'dingtalk',
    replyContext: {
      platform: 'dingtalk',
      chatId: conversationId || undefined,
      sessionWebhook: sessionWebhook || undefined,
    },
    raw: payload,
  };
}

// ── WeCom ──

function parseWeCom(payload: Record<string, unknown>): NormalizedIMMessage | null {
  // WeCom webhook callback (simplified — actual format depends on callback config)
  // { MsgType, Content, From: { UserId, Name }, ... }
  const msgType = String(payload.MsgType ?? payload.msgtype ?? '');
  if (msgType !== 'text') return null;

  const text = String(payload.Content ?? payload.content ?? '');
  if (!text) return null;

  const from = payload.From as Record<string, unknown> | undefined;
  const senderId = String(from?.UserId ?? payload.userId ?? '');
  const senderName = String(from?.Name ?? payload.userName ?? senderId);

  const chatId = String(payload.ChatId ?? payload.chatid ?? '');
  const isMention = text.includes('@Abu') || text.includes('@abu');
  const isDirect = !chatId || chatId === senderId;

  return {
    senderId,
    senderName,
    text: text.replace(/@[Aa]bu\s*/g, '').trim(),
    isMention,
    isDirect,
    chatId: chatId || senderId,
    platform: 'wecom',
    replyContext: {
      platform: 'wecom',
      chatId: chatId || undefined,
    },
    raw: payload,
  };
}

// ── Slack ──

function parseSlack(payload: Record<string, unknown>): NormalizedIMMessage | null {
  // Slack Events API format:
  // { event: { type: "message", text, user, channel, thread_ts, ... } }
  const event = payload.event as Record<string, unknown> | undefined;
  if (!event) return null;

  // Only process user messages
  if (event.type !== 'message') return null;
  if (event.subtype) return null; // skip bot messages, edits, etc.

  const text = String(event.text ?? '');
  if (!text) return null;

  const userId = String(event.user ?? '');
  const channelId = String(event.channel ?? '');
  const threadTs = event.thread_ts ? String(event.thread_ts) : undefined;
  const channelType = String(event.channel_type ?? '');

  // Slack mentions: <@U12345>
  const isMention = /<@\w+>/.test(text);
  const isDirect = channelType === 'im';

  // Clean mention tags
  const cleanText = text.replace(/<@\w+>\s*/g, '').trim();

  return {
    senderId: userId,
    senderName: userId, // Slack doesn't include name in event, would need API call
    text: cleanText,
    isMention,
    isDirect,
    chatId: channelId,
    platform: 'slack',
    replyContext: {
      platform: 'slack',
      chatId: channelId,
      threadId: threadTs,
    },
    raw: payload,
  };
}

// ── WeChat iLink ──

function parseWeChatILink(payload: Record<string, unknown>): NormalizedIMMessage | null {
  // WeChat iLink raw message (already parsed by WeChatInboundAdapter.handleMessage)
  // payload is an ILinkMessage with extra fields merged in by dispatchDirect.
  // The adapter pre-processes item_list into a text string and puts it in
  // a wrapper so inboundRouter can normalize it.

  // The adapter calls dispatchDirect('wechat', rawILinkMsg), so payload IS the ILinkMessage.
  const fromUserId = String(payload.from_user_id ?? '');
  const messageId = String(payload.message_id ?? '');
  const contextToken = String(payload.context_token ?? '');

  if (!fromUserId || !contextToken) return null;

  // Reconstruct text from item_list (re-parse, since handleMessage already did this;
  // here we do a simpler pass for text-only items; media paths were handled by adapter)
  const itemList = payload.item_list as Array<Record<string, unknown>> | undefined;
  if (!itemList?.length) return null;

  const parts: string[] = [];
  for (const item of itemList) {
    const type = item.type as number;
    if (type === 1) {
      const textItem = item.text_item as Record<string, unknown> | undefined;
      if (textItem?.text) parts.push(String(textItem.text));
    } else if (type === 3) {
      // Voice: server-side ASR text
      const voiceItem = item.voice_item as Record<string, unknown> | undefined;
      if (voiceItem?.text) parts.push(`[语音] ${voiceItem.text}`);
      else parts.push('[语音消息]');
    } else if (type === 2) {
      parts.push('[图片]');
    } else if (type === 4) {
      const fileItem = item.file_item as Record<string, unknown> | undefined;
      parts.push(`[文件: ${fileItem?.file_name ?? '未知文件'}]`);
    } else if (type === 5) {
      parts.push('[视频]');
    }
  }

  const text = parts.join('\n').trim();
  if (!text) return null;

  return {
    senderId: fromUserId,
    senderName: fromUserId.split('@')[0] ?? fromUserId,
    text,
    isMention: false, // iLink private chat only; no @mention concept
    isDirect: true,
    chatId: fromUserId,
    platform: 'wechat',
    replyContext: {
      platform: 'wechat',
      chatId: fromUserId,
      messageId,
    },
    raw: payload,
  };
}
