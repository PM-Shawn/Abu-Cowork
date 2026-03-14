import { useScheduleStore } from '../../stores/scheduleStore';
import { useChatStore } from '../../stores/chatStore';
import { useToastStore } from '../../stores/toastStore';
import { runAgentLoop } from '../agent/agentLoop';
import {
  notifyScheduledTaskCompleted,
  notifyScheduledTaskError,
} from '../../utils/notifications';
import { getI18n, format } from '../../i18n';
import type { ScheduledTask } from '../../types/schedule';
import type { ConfirmationInfo, FilePermissionCallback } from '../tools/registry';
import { usePermissionStore } from '../../stores/permissionStore';
import { authorizeWorkspace } from '../tools/pathSafety';
import { outputSender } from '../im/outputSender';
import type { OutputContext } from '../im/adapters/types';

/**
 * Auto-deny confirmation callback for scheduled tasks.
 * Since scheduled tasks run unattended, dangerous commands are automatically rejected.
 */
async function autoDenyConfirmation(_info: ConfirmationInfo): Promise<boolean> {
  console.log('[Scheduler] Auto-denied dangerous command:', _info.command);
  return false;
}

/**
 * Auto file permission callback for scheduled tasks.
 * Auto-allows paths that have persisted grants; auto-denies everything else.
 */
const autoFilePermission: FilePermissionCallback = async (request) => {
  const permStore = usePermissionStore.getState();

  // Check if there's a persisted grant for this path
  if (permStore.hasPermission(request.path, request.capability)) {
    authorizeWorkspace(request.path);
    return true;
  }

  console.log(`[Scheduler] Auto-denied file access: ${request.path} (${request.capability})`);
  return false;
};

const TICK_INTERVAL_MS = 60_000; // 60 seconds

class SchedulerEngine {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private runningTasks = new Set<string>();

  start() {
    if (this.intervalId) return;
    console.log('[Scheduler] Engine started');
    // Run an initial tick immediately to catch missed tasks
    this.tick();
    this.intervalId = setInterval(() => this.tick(), TICK_INTERVAL_MS);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[Scheduler] Engine stopped');
    }
  }

  private tick() {
    const store = useScheduleStore.getState();
    const dueTasks = store.getDueTasks(Date.now());

    for (const task of dueTasks) {
      if (!this.runningTasks.has(task.id)) {
        // Mark as running synchronously to prevent next tick from double-starting
        this.runningTasks.add(task.id);
        this.executeTask(task);
      }
    }
  }

  private async executeTask(task: ScheduledTask) {
    console.log(`[Scheduler] Executing task: ${task.name} (${task.id})`);

    const chatStore = useChatStore.getState();
    const scheduleStore = useScheduleStore.getState();

    // Create a new conversation for this run (skipActivate to avoid disturbing user)
    const conversationId = chatStore.createConversation(
      task.workspacePath ?? null,
      { scheduledTaskId: task.id, skipActivate: true }
    );

    // Set conversation title
    const timeStr = new Date().toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    chatStore.renameConversation(conversationId, `[定时] ${task.name} - ${timeStr}`);

    // Start run tracking
    const runId = scheduleStore.startRun(task.id, conversationId);

    // Build the prompt
    let prompt = task.prompt;
    if (task.skillName) {
      prompt = `/${task.skillName} ${prompt}`;
    }

    try {
      await runAgentLoop(conversationId, prompt, {
        commandConfirmCallback: autoDenyConfirmation,
        filePermissionCallback: autoFilePermission,
      });
      useScheduleStore.getState().completeRun(task.id, runId);

      // Push results to IM channel if configured
      if (task.outputChannelId) {
        await this.pushToIMChannel(task, conversationId);
      }

      notifyScheduledTaskCompleted(task.name);
      const t = getI18n();
      useToastStore.getState().addToast({
        type: 'success',
        title: format(t.schedule.taskCompleted, { name: task.name }),
      });
      console.log(`[Scheduler] Task completed: ${task.name}`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      useScheduleStore.getState().errorRun(task.id, runId, errorMsg);
      notifyScheduledTaskError(task.name);
      const t = getI18n();
      useToastStore.getState().addToast({
        type: 'error',
        title: format(t.schedule.taskError, { name: task.name }),
        message: errorMsg.slice(0, 100),
      });
      console.error(`[Scheduler] Task error: ${task.name}`, err);
    } finally {
      this.runningTasks.delete(task.id);
    }
  }

  async runNow(taskId: string) {
    const store = useScheduleStore.getState();
    const task = store.tasks[taskId];
    if (!task) {
      console.warn(`[Scheduler] Task not found: ${taskId}`);
      return;
    }
    if (this.runningTasks.has(taskId)) {
      console.warn(`[Scheduler] Task already running: ${taskId}`);
      return;
    }
    await this.executeTask(task);
  }

  isTaskRunning(taskId: string): boolean {
    return this.runningTasks.has(taskId);
  }

  private async pushToIMChannel(task: ScheduledTask, conversationId: string) {
    const context: OutputContext = {
      triggerName: task.name,
      aiResponse: '',
      timestamp: new Date().toLocaleString('zh-CN'),
    };

    const baseOutput = {
      enabled: true as const,
      target: 'im_channel' as const,
      outputChannelId: task.outputChannelId,
      extractMode: 'last_message' as const,
    };

    const message = outputSender.buildMessage(conversationId, baseOutput, context);

    // Collect all targets: group chats + DM users
    const targets: { id: string; receiveIdType?: 'chat_id' | 'open_id' }[] = [];

    if (task.outputChatIds) {
      for (const id of task.outputChatIds.split(',').map((s) => s.trim()).filter(Boolean)) {
        targets.push({ id, receiveIdType: 'chat_id' });
      }
    }
    if (task.outputUserIds) {
      for (const id of task.outputUserIds.split(',').map((s) => s.trim()).filter(Boolean)) {
        targets.push({ id, receiveIdType: 'open_id' });
      }
    }

    if (targets.length === 0) {
      console.warn(`[Scheduler] No chat/user IDs configured for ${task.name}, skipping push`);
      return;
    }

    // Send to all targets
    const results = await Promise.allSettled(
      targets.map((t) =>
        outputSender.send(
          { ...baseOutput, outputChatId: t.id },
          message,
          undefined,
          t.receiveIdType,
        )
      )
    );

    const failures = results.filter(
      (r) => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.success)
    );

    if (failures.length === 0) {
      console.log(`[Scheduler] Result pushed to ${targets.length} target(s): ${task.name}`);
    } else {
      console.warn(`[Scheduler] IM push: ${targets.length - failures.length}/${targets.length} succeeded for ${task.name}`);
      const t = getI18n();
      useToastStore.getState().addToast({
        type: 'error',
        title: format(t.schedule.taskCompleted, { name: task.name }),
        message: t.schedule.outputPushFailed,
      });
    }
  }
}

// Singleton instance
export const schedulerEngine = new SchedulerEngine();
