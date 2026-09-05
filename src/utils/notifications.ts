/**
 * Notification facade — producer-side API for the Notice System.
 *
 * All existing callers (agentLoop, scheduler, triggerEngine, skillManage)
 * continue to use these functions unchanged. Internally they now publish
 * through the Notice Bus, which routes to system_notification / menubar /
 * sidebar_badge via the Gate → Router pipeline.
 *
 * Permission init + dock badge clearing are still handled here (exported
 * for App.tsx focus handler).
 */

import {
  isPermissionGranted,
  requestPermission,
} from '@tauri-apps/plugin-notification';
import { publish } from '@/core/notice/bus';
import {
  setNotificationPermission,
  clearDockBadgeCount,
} from '@/core/notice/channels';

let permissionGranted = false;

/**
 * Initialize notification permissions on app startup.
 */
export async function initNotifications(): Promise<boolean> {
  try {
    permissionGranted = await isPermissionGranted();

    if (!permissionGranted) {
      const permission = await requestPermission();
      permissionGranted = permission === 'granted';
    }

    setNotificationPermission(permissionGranted);
    return permissionGranted;
  } catch (err) {
    console.warn('[Notification] Failed to initialize:', err);
    return false;
  }
}

/** Clear dock badge (called on window focus). */
export const clearDockBadge = clearDockBadgeCount;

/**
 * Send a task completion notification.
 */
export async function notifyTaskCompleted(conversationTitle: string, conversationId?: string): Promise<void> {
  publish({
    type: 'task_complete',
    source: 'agent',
    payload: { conversationTitle, conversationId },
    dedupKey: `task_complete:${conversationTitle}:${Date.now()}`,
  });
}

/**
 * Send a scheduled task completion notification.
 */
export async function notifyScheduledTaskCompleted(taskName: string): Promise<void> {
  publish({
    type: 'schedule_fired',
    source: 'scheduler',
    payload: { title: taskName, outcome: 'completed' },
    dedupKey: `schedule_complete:${taskName}:${Date.now()}`,
  });
}

/**
 * Send a scheduled task error notification.
 */
export async function notifyScheduledTaskError(taskName: string): Promise<void> {
  publish({
    type: 'agent_error',
    source: 'scheduler',
    payload: { title: taskName, outcome: 'error' },
    dedupKey: `schedule_error:${taskName}:${Date.now()}`,
  });
}

/**
 * Send a trigger task completion notification.
 */
export async function notifyTriggerCompleted(triggerName: string): Promise<void> {
  publish({
    type: 'task_complete',
    source: 'core',
    payload: { title: triggerName, outcome: 'completed' },
    dedupKey: `trigger_complete:${triggerName}:${Date.now()}`,
  });
}

/**
 * Send a trigger task error notification.
 */
export async function notifyTriggerError(triggerName: string): Promise<void> {
  publish({
    type: 'agent_error',
    source: 'core',
    payload: { title: triggerName, outcome: 'error' },
    dedupKey: `trigger_error:${triggerName}:${Date.now()}`,
  });
}

/**
 * Notify the user that the agent has proposed a new skill draft.
 * Proactivity levels: shy (no-op), companion (badge only), butler (full notification).
 */
export async function notifyDraftProposal(
  draftName: string,
  proactivity: 'shy' | 'companion' | 'butler',
): Promise<void> {
  if (proactivity === 'shy') return;

  publish({
    type: 'skill_proposal_offer',
    source: 'self_evolving',
    payload: { name: draftName, proactivity },
    dedupKey: `skill_proposal:${draftName}`,
    tier: proactivity === 'butler' ? 'L2' : 'L3',
  });
}

/**
 * Send an error notification.
 */
export async function notifyTaskError(conversationTitle: string, conversationId?: string): Promise<void> {
  publish({
    type: 'agent_error',
    source: 'agent',
    payload: { conversationTitle, conversationId },
    dedupKey: `agent_error:${conversationTitle}:${Date.now()}`,
  });
}
