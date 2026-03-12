/**
 * Trigger System Types
 *
 * Triggers are event-driven automation tasks.
 * When an external event occurs, Abu automatically executes the configured action.
 */

// ── Trigger Source ──

export type TriggerSourceType = 'http' | 'file' | 'cron';

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

export type TriggerSource = HttpSource | FileSource | CronSource;

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

// ── Run History ──

export type TriggerRunStatus = 'running' | 'completed' | 'error' | 'filtered' | 'debounced';

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
