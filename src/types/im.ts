/**
 * Shared IM Types — Common types used by both triggers and IM channels
 */

/** Built-in IM platforms shipped with Abu */
type BuiltinIMPlatform = 'feishu' | 'dingtalk' | 'wecom' | 'slack';

/** IM platform identifier — built-in platforms + any plugin-registered platform */
export type IMPlatform = BuiltinIMPlatform | (string & {});

/** Context needed to reply back to the IM source */
export interface IMReplyContext {
  platform: IMPlatform;
  /** Unified chat/channel/vchannel ID — every platform maps its target here */
  chatId?: string;
  /** Original message ID (for threading / reply reference) */
  messageId?: string;
  /** Thread identifier — Slack thread_ts, Feishu root_id, etc. */
  threadId?: string;
  /** Session webhook URL — DingTalk sends this for direct reply (expires in 1h) */
  sessionWebhook?: string;
  /** Platform-specific extra data that core code doesn't need to understand */
  extra?: Record<string, unknown>;
}
