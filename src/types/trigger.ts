/**
 * Trigger System Types
 *
 * Triggers are event-driven automation tasks.
 * When an external event occurs, Abu automatically executes the configured action.
 */

// ── Trigger Source ──

export type TriggerSourceType = 'http' | 'file' | 'cron' | 'im';

export interface HttpSource {
  type: 'http';
  // Endpoint is auto-generated: POST /trigger/{triggerId}
}

export interface FileSource {
  type: 'file';
  /** Path to watch (file or directory) */
  path: string;
  /** File events to listen for */
  events: ('create' | 'modify' | 'delete')[];
  /** Glob pattern filter, e.g. "*.log" (optional) */
  pattern?: string;
}

export interface CronSource {
  type: 'cron';
  /** Interval in seconds */
  intervalSeconds: number;
}

export type IMPlatform = 'dchat' | 'feishu' | 'dingtalk' | 'wecom' | 'slack';

export type IMListenScope = 'all' | 'mention_only' | 'direct_only';

export interface IMSource {
  type: 'im';
  /** IM platform */
  platform: IMPlatform;
  /** App ID for authentication (used by platform webhook verification) */
  appId: string;
  /** App Secret for authentication */
  appSecret: string;
  /** Listening scope: all messages, @mentions only, or direct messages only */
  listenScope: IMListenScope;
}

export type TriggerSource = HttpSource | FileSource | CronSource | IMSource;

// ── Filter ──

export type TriggerFilterType = 'always' | 'keyword' | 'regex';

export interface TriggerFilter {
  type: TriggerFilterType;
  /** Keywords to match (when type='keyword') */
  keywords?: string[];
  /** Regex pattern (when type='regex') */
  pattern?: string;
  /** Match against a specific field in event data (default: entire JSON) */
  field?: string;
}

// ── Debounce ──

export interface DebounceConfig {
  enabled: boolean;
  /** Deduplication window in seconds */
  windowSeconds: number;
}

// ── Quiet Hours ──

export interface QuietHoursConfig {
  enabled: boolean;
  /** Start time, e.g. "22:00" */
  start: string;
  /** End time, e.g. "08:00" */
  end: string;
}

// ── Action ──

export interface TriggerAction {
  /** Skill to invoke (optional) */
  skillName?: string;
  /** Prompt sent to Agent. Use $EVENT_DATA for event data placeholder. */
  prompt: string;
  /** Workspace path for the agent (optional) */
  workspacePath?: string;
}

// ── Output Config ──

export type OutputPlatform = 'dchat' | 'feishu' | 'dingtalk' | 'wecom' | 'slack' | 'custom';

export type OutputExtractMode = 'last_message' | 'full' | 'custom_template';

export interface TriggerOutput {
  enabled: boolean;
  /** Output target: webhook sends to URL, reply_source replies to the IM that triggered */
  target: 'webhook' | 'reply_source';
  /** Platform (required when target='webhook') */
  platform?: OutputPlatform;
  /** Webhook URL (required when target='webhook') */
  webhookUrl?: string;
  extractMode: OutputExtractMode;
  customTemplate?: string;
  /** Custom HTTP headers (for 'custom' platform, e.g. Authorization) */
  customHeaders?: Record<string, string>;
}

// ── Run History ──

export type TriggerRunStatus = 'running' | 'completed' | 'error' | 'filtered' | 'debounced';

export type TriggerOutputStatus = 'pending' | 'sent' | 'failed';

export interface TriggerRun {
  id: string;
  triggerId: string;
  /** Associated conversation ID for viewing results */
  conversationId: string;
  startedAt: number;
  completedAt?: number;
  status: TriggerRunStatus;
  /** Truncated event summary for display */
  eventSummary?: string;
  error?: string;
  /** Output push status */
  outputStatus?: TriggerOutputStatus;
  outputError?: string;
  outputSentAt?: number;
  /** Reply context for reply_source output (Phase 1B) */
  replyContext?: IMReplyContext;
}

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

// ── Main Trigger ──

export type TriggerStatus = 'active' | 'paused';

export interface Trigger {
  id: string;
  name: string;
  description?: string;
  status: TriggerStatus;
  source: TriggerSource;
  filter: TriggerFilter;
  action: TriggerAction;
  debounce: DebounceConfig;
  quietHours?: QuietHoursConfig;
  /** Output push config (optional) */
  output?: TriggerOutput;
  createdAt: number;
  updatedAt: number;
  lastTriggeredAt?: number;
  /** Recent run history (max 20) */
  runs: TriggerRun[];
  totalRuns: number;
}

// ── HTTP Event Payload ──

export interface TriggerEventPayload {
  data: Record<string, unknown>;
}
