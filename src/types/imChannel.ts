/**
 * IM Channel Types — Phase 2: IM independent channel
 *
 * An IM channel connects Abu to an IM platform for direct interaction.
 * Users can @Abu in groups or DM the bot to use Abu's capabilities.
 */

import type { IMPlatform } from './im';

// ── Capability Levels ──

export type IMCapabilityLevel = 'chat_only' | 'read_tools' | 'safe_tools' | 'full';

/** Controls when Abu responds in group chats */
export type IMResponseMode = 'mention_only' | 'all_messages';

// ── Channel Config ──

export type IMChannelStatus = 'connected' | 'connecting' | 'disconnected' | 'error';

export interface IMChannel {
  id: string;
  /** IM platform */
  platform: IMPlatform;
  /** Display name (user-defined) */
  name: string;
  /** App credentials */
  appId: string;
  appSecret: string;
  /** Capability level for this channel */
  capability: IMCapabilityLevel;
  /** When to respond in group chats (default: mention_only) */
  responseMode: IMResponseMode;
  /** Allowed user IDs (empty = everyone) */
  allowedUsers: string[];
  /** Allowed workspace paths */
  workspacePaths: string[];
  /** Session timeout in minutes (default 30) */
  sessionTimeoutMinutes: number;
  /** Max rounds per session (default 50) */
  maxRoundsPerSession: number;
  /** Whether channel is enabled */
  enabled: boolean;
  /** Connection status (runtime, not persisted) */
  status: IMChannelStatus;
  /** Last error message */
  lastError?: string;
  /** Created timestamp */
  createdAt: number;
  /** Updated timestamp */
  updatedAt: number;
}

// ── Session ──

export interface IMSession {
  /** Unique key: "platform:chatId:threadId" or "platform:chatId:window" */
  key: string;
  /** Channel ID this session belongs to */
  channelId: string;
  /** Abu conversation ID */
  conversationId: string;
  /** Last interaction timestamp */
  lastActiveAt: number;
  /** Number of message rounds in this session */
  messageCount: number;
  /** Source user ID */
  userId: string;
  /** User display name */
  userName: string;
  /** Resolved capability level (may differ from channel config due to AuthGate) */
  capability: IMCapabilityLevel;
  /** Platform */
  platform: IMPlatform;
  /** Chat/group ID */
  chatId: string;
  /** Chat/group name */
  chatName?: string;
}

// ── Channel Statistics ──

export interface IMChannelStats {
  /** Number of active sessions */
  activeSessions: number;
  /** Total messages received today */
  todayMessages: number;
  /** Last connected timestamp */
  lastConnectedAt?: number;
}
