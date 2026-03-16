/**
 * Shared IM Types — Common types used by both triggers and IM channels
 */

export type IMPlatform = 'dchat' | 'feishu' | 'dingtalk' | 'wecom' | 'slack';

/** Context needed to reply back to the IM source */
export interface IMReplyContext {
  platform: IMPlatform;
  /** D-Chat: vchannel ID */
  vchannelId?: string;
  /** Feishu: chat ID for replying */
  chatId?: string;
  /** Feishu: original message ID for threading */
  messageId?: string;
  /** DingTalk: session webhook URL (expires in 1h) */
  sessionWebhook?: string;
  /** Slack: channel ID */
  channelId?: string;
  /** Slack: thread timestamp for threading */
  threadTs?: string;
  /** WeCom: chat ID */
  chatid?: string;
}
