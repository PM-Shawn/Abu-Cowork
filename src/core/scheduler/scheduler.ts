import { useScheduleStore } from '../../stores/scheduleStore';
import { useChatStore } from '../../stores/chatStore';
import { useToastStore } from '../../stores/toastStore';
import { isIncompleteReason } from '../agent/agentLoop';
import { runAgentLoopDispatched } from '../agent/agentLoopRunner';
import {
  notifyScheduledTaskCompleted,
  notifyScheduledTaskError,
} from '../../utils/notifications';
import { getI18n, format } from '../../i18n';
import type { ScheduledTask } from '../../types/schedule';
import type { PermissionMode } from '../permissions/permissionMode';
import type { ConfirmationInfo, FilePermissionCallback } from '../tools/registry';
import { authorizeWorkspace } from '../tools/pathSafety';
import { getSettingsReader } from '../agent/ports/settingsReader';
import { TOOL_NAMES } from '../tools/toolNames';
import { outputSender } from '../im/outputSender';
import type { OutputContext } from '../im/adapters/types';

/** How many distinct denials to quote back; beyond this the list is summarized. */
const MAX_REPORTED_DENIALS = 5;

/** task.permissionMode, falling back to the global settings mode — the same
 *  fallback registry.ts applies for a conversation carrying no mode of its
 *  own. `undefined` on the task means "follow settings", not "strictest". */
function resolveEffectivePermissionMode(task: ScheduledTask): PermissionMode {
  return task.permissionMode ?? getSettingsReader().getSnapshot().permissionMode;
}

/** Same wording chat's PermissionModeChip uses — no scheduler-only vocabulary. */
function permissionModeLabel(mode: PermissionMode): string {
  const t = getI18n();
  switch (mode) {
    case 'smart': return t.settings.permissionModeSmart;
    case 'autonomous': return t.settings.permissionModeAutonomous;
    case 'standard':
    default: return t.settings.permissionModeStandard;
  }
}

/**
 * Permission callbacks for one scheduled run, plus a recorder for whatever got
 * refused.
 *
 * There is nobody unattended to answer a confirmation, so this reuses the
 * exact gate chat itself uses instead of a scheduler-only tier vocabulary:
 * `executeTask` sets the run's conversation `permissionMode` (via
 * `setConversationPermissionMode`) to the task's mode (or leaves it unset to
 * follow the global settings mode), and `registry.ts` already reads that
 * per-conversation mode — same standard/smart/autonomous strategy, same AI
 * reviewer for 'smart' escalations. These callbacks only decide what happens
 * on the "confirm" outcome that strategy produces: whatever reaches here
 * would have popped a dialog in an interactive session, so with nobody
 * present it is an auto-deny, regardless of mode. ('smart' still gets its AI
 * reviewer pass first — a low-risk escalation there can be silently allowed
 * without ever reaching this callback; 'autonomous' still routes browser/
 * self-extension actions through this same confirm gate, per the hard floor
 * `decideOtherTool` keeps in every mode.)
 *
 * The recorder exists because of the failure mode this whole change is about:
 * a task used to run at 3am, hit a permission wall, and surface nothing but
 * "failed". Browser gating flows through the same confirmation callback (the
 * registry calls `onRequireConfirmation` with `kind: 'browser'` and the
 * origin), so per-site refusals land here too — that is what makes the
 * "blocked on example.com, authorize it in Settings" message possible without
 * a separate accounting layer.
 */
function resolveScheduledRunPermissions(task: ScheduledTask): {
  commandConfirmCallback: (info: ConfirmationInfo) => Promise<boolean>;
  filePermissionCallback: FilePermissionCallback;
  blockedTools: string[];
  getDenials: () => string[];
} {
  // The workspace gets the same rights an interactive chat conversation would
  // have in it — standard/smart/autonomous all treat "inside the authorized
  // workspace" as free read+write; the ceiling is entirely about escalations
  // (outside the workspace, risky commands, browser actions), not about
  // capping the workspace itself to read-only. Unlike the old TriggerCapability
  // tiers this model has no read-only rung, so there is nothing to restrict here.
  if (task.workspacePath) {
    authorizeWorkspace(task.workspacePath);
  }

  // Deduplicated: an agent retrying the same blocked action ten times should
  // produce one line, not ten.
  const denials = new Set<string>();

  return {
    commandConfirmCallback: async (info) => {
      const t = getI18n();
      denials.add(
        info.kind === 'browser' && info.browserOrigin
          ? format(t.schedule.denialBrowserSite, { origin: info.browserOrigin })
          : format(t.schedule.denialCommand, { command: info.command }),
      );
      return false;
    },
    filePermissionCallback: async (request) => {
      const t = getI18n();
      denials.add(format(t.schedule.denialFile, { path: request.path }));
      return false;
    },
    // request_workspace pops a UI dialog a scheduled run can never answer.
    blockedTools: [TOOL_NAMES.REQUEST_WORKSPACE],
    getDenials: () => Array.from(denials),
  };
}

/**
 * Turn recorded denials into the sentence appended to a failed run's result
 * text, including where to grant what was missing (plan §4.4 — say the reason
 * in the result, do not build a separate accounting UI).
 */
function describeDenials(denials: string[], mode: PermissionMode): string {
  if (denials.length === 0) return '';
  const t = getI18n();
  const shown = denials.slice(0, MAX_REPORTED_DENIALS);
  const more = denials.length - shown.length;
  const list = shown.join('; ') + (more > 0 ? format(t.schedule.denialMore, { count: String(more) }) : '');
  return format(t.schedule.denialSummary, {
    mode: permissionModeLabel(mode),
    list,
  });
}

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
      { scheduledTaskId: task.id, projectId: task.projectId, skipActivate: true }
    );
    // Selects the standard/smart/autonomous strategy `registry.ts` applies to
    // every tool call in this run. `task.permissionMode` is undefined for a
    // "follow settings" task — passing that through leaves the conversation's
    // mode unset, which is exactly the fallback registry.ts already reads
    // from the global settings mode.
    chatStore.setConversationPermissionMode(conversationId, task.permissionMode);

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

    const permissions = resolveScheduledRunPermissions(task);

    try {
      const result = await runAgentLoopDispatched(conversationId, prompt, {
        commandConfirmCallback: permissions.commandConfirmCallback,
        filePermissionCallback: permissions.filePermissionCallback,
        blockedTools: permissions.blockedTools,
      });

      // max_turns hit the cap but still produced a usable (partial) answer — deliver
      // it like a completion, just flagged as possibly incomplete, rather than
      // silently dropping the output. (no_progress / error / aborted have no usable
      // output, so they skip delivery below.)
      if (result.reason === 'completed' || result.reason === 'max_turns') {
        const incomplete = result.reason === 'max_turns';
        useScheduleStore.getState().completeRun(task.id, runId);

        // Push results to IM channel if configured
        if (task.outputChannelId) {
          await this.pushToIMChannel(task, conversationId);
        }

        const t = getI18n();
        if (incomplete) {
          // Delivered, but warn the cap was reached.
          useToastStore.getState().addToast({
            type: 'info',
            title: format(t.schedule.taskCompleted, { name: task.name }),
            message: 'Reached the turn limit — result may be incomplete',
          });
          console.log(`[Scheduler] Task hit turn limit (partial result delivered): ${task.name}`);
        } else {
          notifyScheduledTaskCompleted(task.name);
          useToastStore.getState().addToast({
            type: 'success',
            title: format(t.schedule.taskCompleted, { name: task.name }),
          });
          console.log(`[Scheduler] Task completed: ${task.name}`);
        }
      } else {
        // aborted, error, or no_progress (degenerate output) — no delivery; mark the
        // run with a reason-specific message instead of "Unknown error".
        const baseError = result.error ?? (
          result.reason === 'aborted' ? 'Task was cancelled'
          : result.reason === 'no_progress' ? 'Stopped: the model produced no usable tool calls'
          : 'Unknown error'
        );
        // A task that failed after being blocked used to read as a bare
        // "failed". Say what was refused and at which tier, so the run history
        // carries the fix instead of the user having to guess.
        const errorMsg = baseError + describeDenials(
          permissions.getDenials(),
          resolveEffectivePermissionMode(task),
        );
        useScheduleStore.getState().errorRun(task.id, runId, errorMsg);
        if (result.reason === 'error' || isIncompleteReason(result.reason)) {
          notifyScheduledTaskError(task.name);
        }
        const t = getI18n();
        useToastStore.getState().addToast({
          type: result.reason === 'aborted' ? 'info' : 'error',
          title: format(result.reason === 'aborted' ? t.schedule.taskCompleted : t.schedule.taskError, { name: task.name }),
          message: result.reason === 'aborted' ? undefined : errorMsg.slice(0, 100),
        });
        console.log(`[Scheduler] Task ${result.reason}: ${task.name}`, result.error ?? '');
      }
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
