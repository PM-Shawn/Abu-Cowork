/**
 * Trigger System Types
 *
 * Triggers are event-driven automation tasks.
 * When an external event occurs, Abu automatically executes the configured action.
 */

import type { IMReplyContext } from './im';

// Re-export shared IM types for backwards compatibility
export type { IMPlatform, IMReplyContext } from './im';

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

export type IMListenScope = 'all' | 'mention_only' | 'direct_only';

export interface IMSource {
  type: 'im';
  /** Reference to an IM channel ID (credentials managed by the channel) */
  channelId: string;
  /** Listening scope: all messages, @mentions only, or direct messages only */
  listenScope: IMListenScope;
  /** Only listen to messages from a specific chat/group (optional, user copies ID from IM platform) */
  chatId?: string;
  /** Sender match filter — name or ID (optional) */
  senderMatch?: string;
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

// ── Capability & Permissions ──

/**
 * Trigger capability level — determines what the trigger can do at runtime.
 * Permissions are declared at creation time (no runtime dialogs for unattended execution).
 *
 * - read_tools:  Read files, search, web fetch — no modifications (default, safest)
 * - safe_tools:  Read + write within workspace, safe commands only (ls, git status, etc.)
 * - full:        All operations except hard-blocked paths/commands (.ssh, rm -rf /, etc.)
 * - custom:      Fine-grained control via TriggerPermissions whitelist
 */
export type TriggerCapability = 'read_tools' | 'safe_tools' | 'full' | 'custom';

export interface TriggerPermissions {
  /** Command whitelist — glob patterns (e.g. "npm run *", "git pull", "curl *") */
  allowedCommands?: string[];
  /** Path whitelist — auto-authorized at execution time (e.g. "/Users/xx/project/src") */
  allowedPaths?: string[];
  /** Tool whitelist — if empty, no restriction (e.g. ["read_file", "http_fetch"]) */
  allowedTools?: string[];
}

// ── Action ──

export interface TriggerAction {
  /** Skill to invoke (optional) */
  skillName?: string;
  /** Prompt sent to Agent. Use $EVENT_DATA for event data placeholder. */
  prompt: string;
  /** Workspace path for the agent (optional) */
  workspacePath?: string;
  /** Capability level (default: read_tools) */
  capability?: TriggerCapability;
  /** Custom permissions (only used when capability='custom') */
  permissions?: TriggerPermissions;
}

// ── Output Config ──

/** Output platform — built-in platforms + 'custom' + any plugin-registered platform */
export type OutputPlatform = 'feishu' | 'dingtalk' | 'wecom' | 'slack' | 'custom' | (string & {});

export type OutputExtractMode = 'last_message' | 'full' | 'custom_template';

export interface TriggerOutput {
  enabled: boolean;
  /** Output target: webhook sends to URL, im_channel pushes via IM channel */
  target: 'webhook' | 'im_channel';
  /** Platform (required when target='webhook') */
  platform?: OutputPlatform;
  /** Webhook URL (required when target='webhook') */
  webhookUrl?: string;
  /** IM channel ID to push to (required when target='im_channel') */
  outputChannelId?: string;
  /** Comma-separated group chat IDs (optional, defaults to reply source chat for IM triggers) */
  outputChatIds?: string;
  /** Comma-separated user IDs for DM */
  outputUserIds?: string;
  /** Single target chat ID (internal, used by scheduler per-target dispatch) */
  outputChatId?: string;
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
  /** Reply context for im_channel output */
  replyContext?: IMReplyContext;
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
