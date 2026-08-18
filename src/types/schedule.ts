/**
 * Scheduled Task Types
 */

import type { TriggerCapability } from './trigger';

export type ScheduleFrequency = 'hourly' | 'daily' | 'weekly' | 'weekdays' | 'manual';

/**
 * How much a scheduled task may do while it runs unattended.
 *
 * This is the *ceiling* half of the permission model (permission plan §2):
 * nobody is around to answer a confirmation, so the task's tier decides what
 * runs and everything above it is refused. Before this existed the scheduler
 * hard-coded "deny everything that needs asking", which is why tasks that
 * needed to touch a web page just failed at 3am with no explanation.
 *
 * Deliberately the same vocabulary as `TriggerCapability` rather than a new
 * enum — triggers, IM channels and scheduled tasks are the same unattended
 * question, and `resolveTriggerCallbacks` already implements these three
 * tiers. 'custom' is excluded: it needs a per-action whitelist
 * (`TriggerPermissions`) that scheduled tasks have no UI for.
 */
export type ScheduledTaskPermissionMode = Exclude<TriggerCapability, 'custom'>;

/** Safe default (plan §7 decision B): read-only unless the user opens it up. */
export const DEFAULT_SCHEDULED_PERMISSION_MODE: ScheduledTaskPermissionMode = 'read_tools';
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
  /** What the task may do while running unattended (default: read_tools) */
  permissionMode?: ScheduledTaskPermissionMode;
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
