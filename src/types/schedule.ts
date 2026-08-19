/**
 * Scheduled Task Types
 */

import type { PermissionMode } from '../core/permissions/permissionMode';

export type ScheduleFrequency = 'hourly' | 'daily' | 'weekly' | 'weekdays' | 'manual';

export type ScheduledTaskStatus = 'active' | 'paused';
export type ScheduledRunStatus = 'running' | 'completed' | 'error';

export interface ScheduleConfig {
  frequency: ScheduleFrequency;
  /** Execution time (hour:minute). For hourly, only minute is used. */
  time?: { hour: number; minute: number };
  /** Day of week for 'weekly' frequency (0=Sunday, 1=Monday, ..., 6=Saturday) */
  dayOfWeek?: number;
}

export interface ScheduledTask {
  id: string;
  name: string;
  /** Optional description / purpose of the task */
  description?: string;
  prompt: string;
  schedule: ScheduleConfig;
  status: ScheduledTaskStatus;
  /** Optional skill binding */
  skillName?: string;
  /** Optional workspace path */
  workspacePath?: string;
  /** Optional IM channel ID to push results to after completion */
  outputChannelId?: string;
  /** Comma-separated group chat IDs to push to */
  outputChatIds?: string;
  /** Comma-separated user open_ids to DM */
  outputUserIds?: string;
  /** Project this task belongs to */
  projectId?: string;
  /**
   * The permission mode this task runs under while unattended. Reuses chat's
   * own three-tier autonomy axis (`standard`/`smart`/`autonomous`,
   * `src/core/permissions/permissionMode.ts`) rather than a scheduler-only
   * vocabulary — same words a user already learned from the chat window.
   * `undefined` means "follow the global settings permission mode", which is
   * the default; it is NOT the same as picking the strictest tier
   * explicitly. Confirmation-requiring actions have nobody to ask while
   * unattended, so `standard`'s escalations and `smart`'s AI-reviewer
   * escalations are both denied (with the reason recorded into the run's
   * result text) rather than degrading to a prompt.
   */
  permissionMode?: PermissionMode;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  nextRunAt?: number;
  /** Recent run history (max 20) */
  runs: ScheduledTaskRun[];
  totalRuns: number;
}

export interface ScheduledTaskRun {
  id: string;
  scheduledTaskId: string;
  /** Associated conversation ID for viewing results */
  conversationId: string;
  startedAt: number;
  completedAt?: number;
  status: ScheduledRunStatus;
  error?: string;
}
