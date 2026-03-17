/**
 * SessionMapper — Map IM messages to Abu conversations
 *
 * Session resolution rules:
 * 1. Has thread (Slack thread_ts, Feishu messageId reply) → key = "platform:chatId:threadId"
 * 2. Group chat, no thread → key = "platform:chatId:senderId:window" (per-user isolation)
 * 3. P2P/direct chat → key = "platform:chatId:window"
 * 4. Timeout (0 = no timeout, otherwise N minutes) → create new session
 * 5. "继续上次" / "continue" → recover previous session
 * 6. "新对话" / "new chat" / "reset" → force new session
 */

import { useIMChannelStore } from '../../stores/imChannelStore';
import { useChatStore } from '../../stores/chatStore';
import type { IMSession, IMCapabilityLevel } from '../../types/imChannel';

import type { NormalizedIMMessage } from './inboundRouter';
import type { IMChannel } from '../../types/imChannel';

export interface SessionResolveResult {
  session: IMSession;
  isNew: boolean;
  /** If user asked to recover previous session */
  isRecovered?: boolean;
  /** If user explicitly requested a session reset ("新对话") */
  isReset?: boolean;
  /** If there's a previous session that can be recovered (hint the user) */
  hasRecoverableSession?: boolean;
  /** Brief context of the recoverable session */
  recoverableContext?: string;
  /** ConversationId of the previous session that was archived (for memory extraction) */
  archivedConversationId?: string;
}

const CONTINUE_PATTERNS = [
  '继续上次',
  '继续上一次',
  '恢复上次',
  'continue',
  'continue last',
  'resume',
];

const RESET_PATTERNS = [
  '新对话',
  '新话题',
  'new chat',
  'reset',
];

export class SessionMapper {
  /**
   * Peek at the session key for a message without any side effects.
   * Useful for per-session queue routing.
   */
  peekSessionKey(message: NormalizedIMMessage): string {
    return this.buildKey(message);
  }

  /**
   * Resolve which Abu conversation this IM message belongs to.
   */
  resolve(
    message: NormalizedIMMessage,
    channel: IMChannel,
    capability: IMCapabilityLevel,
  ): SessionResolveResult {
    const store = useIMChannelStore.getState();
    const sessionKey = this.buildKey(message);

    // Check for "new chat" reset request
    if (this.isResetRequest(message.text)) {
      const existing = store.sessions[sessionKey];
      const archivedConvId = existing?.conversationId;
      if (existing) {
        store.archiveSession(this.buildWindowKey(message), existing);
        store.removeSession(sessionKey);
      }
      const newSession = this.createSession(message, channel, capability);
      store.upsertSession(sessionKey, newSession);
      return { session: newSession, isNew: true, isReset: true, archivedConversationId: archivedConvId };
    }

    // Check for "continue last" request
    if (this.isContinueRequest(message.text)) {
      const prev = store.archivedSessions[this.buildWindowKey(message)];
      if (prev) {
        // Recover previous session
        const recovered: IMSession = {
          ...prev,
          lastActiveAt: Date.now(),
          capability,
        };
        const context = this.getSessionContext(prev.conversationId);
        store.upsertSession(prev.key, recovered);
        store.removeArchivedSession(this.buildWindowKey(message));
        return { session: recovered, isNew: false, isRecovered: true, recoverableContext: context };
      }
    }

    // Look for existing session
    const existing = store.sessions[sessionKey];
    let archivedConvId: string | undefined;

    if (existing) {
      // Check if the underlying conversation still exists (user may have deleted it in Abu)
      const convExists = !!useChatStore.getState().conversations[existing.conversationId];
      const timeoutMs = channel.sessionTimeoutMinutes * 60 * 1000;
      const isExpired = timeoutMs > 0 && (Date.now() - existing.lastActiveAt > timeoutMs);

      if (convExists && !isExpired) {
        // Session still valid
        store.incrementSessionRound(sessionKey);
        return { session: { ...existing, messageCount: existing.messageCount + 1 }, isNew: false };
      }

      // Session expired or conversation deleted — archive for potential recovery
      archivedConvId = existing.conversationId;
      store.archiveSession(this.buildWindowKey(message), existing);
      store.removeSession(sessionKey);
    }

    // Create new session
    const newSession = this.createSession(message, channel, capability);
    store.upsertSession(sessionKey, newSession);

    // Check if there's a recoverable previous session to hint the user
    const windowKey = this.buildWindowKey(message);
    const prev = store.archivedSessions[windowKey];
    if (prev) {
      const context = this.getSessionContext(prev.conversationId);
      return {
        session: newSession,
        isNew: true,
        hasRecoverableSession: true,
        recoverableContext: context,
        archivedConversationId: archivedConvId,
      };
    }

    return { session: newSession, isNew: true, archivedConversationId: archivedConvId };
  }

  /**
   * Build session key from message.
   * Thread-aware platforms use thread ID; others use window-based key.
   */
  private buildKey(message: NormalizedIMMessage): string {
    // Thread-aware platforms (Slack thread_ts, etc.)
    if (message.replyContext.threadId) {
      return `${message.platform}:${message.chatId}:${message.replyContext.threadId}`;
    }
    // Feishu: only use messageId as thread key for group replies (not every message)
    // In p2p (direct) chats, all messages belong to the same window session.
    // In group chats, messageId changes per message — use window key too.
    // Thread-based routing for Feishu would need parent_id (not yet parsed).
    // Others: window-based
    return this.buildWindowKey(message);
  }

  private buildWindowKey(message: NormalizedIMMessage): string {
    // Group chats: isolate sessions per user to prevent context leakage
    // P2P/direct chats: only one user, no need for senderId in key
    if (!message.isDirect && message.senderId) {
      return `${message.platform}:${message.chatId}:${message.senderId}:window`;
    }
    return `${message.platform}:${message.chatId}:window`;
  }

  private createSession(
    message: NormalizedIMMessage,
    channel: IMChannel,
    capability: IMCapabilityLevel,
  ): IMSession {
    // Create a new Abu conversation for this IM session
    const chatStore = useChatStore.getState();
    const workspacePath = channel.workspacePaths[0] ?? null;
    const conversationId = chatStore.createConversation(workspacePath, {
      skipActivate: true,
      imChannelId: channel.id,
      imPlatform: message.platform,
    });

    // Set conversation title — use readable name or first message text (no platform prefix)
    const displayName = this.isReadableName(message.senderName)
      ? message.senderName
      : message.text.slice(0, 30).trim() || message.senderName;
    const title = message.chatName ? `${displayName} · ${message.chatName}` : displayName;
    chatStore.renameConversation(conversationId, title);

    return {
      key: this.buildKey(message),
      channelId: channel.id,
      conversationId,
      lastActiveAt: Date.now(),
      messageCount: 1,
      userId: message.senderId,
      userName: message.senderName,
      capability,
      platform: message.platform,
      chatId: message.chatId,
      chatName: message.chatName,
    };
  }

  /**
   * Extract a brief context summary from a conversation (first user message + last AI message).
   */
  private getSessionContext(conversationId: string): string {
    const conversations = useChatStore.getState().conversations;
    if (!conversations) return '';
    const conv = conversations[conversationId];
    if (!conv) return '';

    const userMsgs = conv.messages.filter((m) => m.role === 'user');
    const aiMsgs = conv.messages.filter((m) => m.role === 'assistant');

    const firstUser = userMsgs[0];
    const lastAI = aiMsgs[aiMsgs.length - 1];

    const parts: string[] = [];
    if (firstUser) {
      const text = typeof firstUser.content === 'string' ? firstUser.content : '';
      parts.push(text.slice(0, 50));
    }
    if (lastAI) {
      const text = typeof lastAI.content === 'string' ? lastAI.content : '';
      parts.push(text.slice(0, 50));
    }

    return parts.join(' → ') || '(无上下文)';
  }

  /**
   * Check if a name is human-readable (not a raw platform ID like ou_xxx, U12345, etc.)
   */
  private isReadableName(name: string): boolean {
    if (!name) return false;
    // Feishu open_id / union_id
    if (/^ou_[a-f0-9]{16,}$/i.test(name)) return false;
    if (/^on_[a-f0-9]{16,}$/i.test(name)) return false;
    // Slack user ID
    if (/^[UW][A-Z0-9]{8,}$/.test(name)) return false;
    // Generic hex/UUID-like strings
    if (/^[a-f0-9-]{16,}$/i.test(name)) return false;
    return true;
  }

  private isContinueRequest(text: string): boolean {
    const lower = text.toLowerCase().trim();
    return CONTINUE_PATTERNS.some((p) => lower === p || lower.startsWith(p));
  }

  private isResetRequest(text: string): boolean {
    const lower = text.toLowerCase().trim();
    return RESET_PATTERNS.some((p) => lower === p || lower.startsWith(p));
  }

  /**
   * Clean up expired sessions and archive them for recovery.
   */
  cleanup() {
    const store = useIMChannelStore.getState();
    const now = Date.now();

    for (const [key, session] of Object.entries(store.sessions)) {
      const channel = store.channels[session.channelId];
      const timeoutMs = (channel?.sessionTimeoutMinutes ?? 0) * 60 * 1000;

      // timeout 0 = no timeout, skip expiry for that session
      if (timeoutMs > 0 && now - session.lastActiveAt > timeoutMs) {
        // Archive for "continue last" recovery
        store.archiveSession(session.key, session);
        store.removeSession(key);
      }
    }

    // Clean up very old archived sessions (>24h)
    const maxArchiveAge = 24 * 60 * 60 * 1000;
    for (const [key, session] of Object.entries(store.archivedSessions)) {
      if (now - session.lastActiveAt > maxArchiveAge) {
        store.removeArchivedSession(key);
      }
    }
  }
}

export const sessionMapper = new SessionMapper();
