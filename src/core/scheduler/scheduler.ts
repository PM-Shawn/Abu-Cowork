import { useScheduleStore } from '../../stores/scheduleStore';
import { useChatStore } from '../../stores/chatStore';
import { useToastStore } from '../../stores/toastStore';
import { isIncompleteReason } from '../agent/agentLoop';
import { BROWSER_DENIAL_ABORT_CAUSE } from '../agent/browserDenialTracker';
import { runAgentLoopDispatched } from '../agent/agentLoopRunner';
import {
  notifyScheduledTaskCompleted,
  notifyScheduledTaskError,
} from '../../utils/notifications';
import { getI18n, format } from '../../i18n';
import type { ScheduledTask } from '../../types/schedule';
import type { PermissionMode } from '../permissions/permissionMode';
import type { ConfirmationInfo, FilePermissionCallback } from '../tools/registry';
import {
  createAuthorizationScope,
  disposeAuthorizationScope,
  scopedAuthorizeWorkspace,
} from '../tools/pathSafety';
import { getSettingsReader } from '../agent/ports/settingsReader';
import { TOOL_NAMES } from '../tools/toolNames';
import { outputSender } from '../im/outputSender';
import { resolveUnattendedImTarget } from '../im/approvalTarget';
import type { AbuMessage, MessageColor, OutputContext } from '../im/adapters/types';
import { getToolInvoker } from '../agent/ports/toolInvoker';
import { buildScheduledRunPermissionCeiling } from '../permissions/runPermissionCeiling';
import { createUnattendedConfirmation } from '../permissions/unattendedConfirmation';
import {
  buildSchedulerDriftSignal,
  getBrowserSignalCursor,
  safeRecordSchedulerDriftSignal,
} from '../observability/browserSignals';
import {
  browserRunReportOutcomeFor,
  type BrowserRunReportSnapshot,
} from '../observability/browserRunReport';
import {
  appendBrowserRunReportMessage,
  buildUnattendedBrowserReport,
} from '../observability/browserRunReportEmitter';
import {
  deriveUnattendedRunOutcome,
  formatUnattendedOutcomeSummary,
  type UnattendedRunOutcome,
} from '../observability/unattendedRunOutcome';

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
function resolveScheduledRunPermissions(
  task: ScheduledTask,
  authorizationScopeId: string,
  conversationId?: string,
): {
  commandConfirmCallback: (info: ConfirmationInfo) => Promise<boolean>;
  filePermissionCallback: FilePermissionCallback;
  blockedTools: string[];
  /**
   * F1 — the same approval destination the callback closure carries, returned
   * so the run can also publish it as trusted run context. Gates that build
   * their own seam request (the browser gate) never call the callback, so the
   * closure alone left them with nowhere to ask.
   */
  unattendedApproval: import('../permissions/unattendedConfirmation').UnattendedApprovalContext;
  getDenials: () => string[];
} {
  // The workspace gets the same rights an interactive chat conversation would
  // have in it — standard/smart/autonomous all treat "inside the authorized
  // workspace" as free read+write; the ceiling is entirely about escalations
  // (outside the workspace, risky commands, browser actions), not about
  // capping the workspace itself to read-only. Unlike the old TriggerCapability
  // tiers this model has no read-only rung, so there is nothing to restrict here.
  if (task.workspacePath) {
    scopedAuthorizeWorkspace(authorizationScopeId, task.workspacePath);
  }

  // Deduplicated: an agent retrying the same blocked action ten times should
  // produce one line, not ten.
  const denials = new Set<string>();

  /*
    Where this run may ask, when its policy says「每次询问」.

    A scheduled run mints a fresh conversation every time, so the seam's
    fallback — the IM session bound to the conversation — never finds
    anything, and until this was passed, every ask in an automatic task
    refused itself with `no_binding`. The task already names a channel: the
    one its RESULTS go to. Approvals now go to the same place, addressed the
    same way (`resolveUnattendedImTarget` mirrors `pushToIMChannel`).

    Null when the task nominates no channel — the old behavior, deliberately:
    guessing a channel would route a 3am approval for someone's signed-in
    banking session into a chat they never chose.
  */
  const imTarget = resolveUnattendedImTarget(task);

  return {
    // One seam for "an unattended run needs approval" (see
    // `unattendedConfirmation.ts`) instead of a hand-rolled always-false
    // closure per entry point. The recorder below turns a refusal into a
    // user-readable line; the IM round-trip is what can now turn it into an
    // approval instead.
    commandConfirmCallback: createUnattendedConfirmation({
      source: 'scheduler',
      ...(conversationId !== undefined ? { conversationId } : {}),
      ...(imTarget !== null ? { imTarget } : {}),
      // Names the automation in the IM prompt: a user with several tasks
      // cannot otherwise tell which one is asking.
      runLabel: task.name,
      onDenied: (reason, info) => {
        const t = getI18n();
        denials.add(
          // A refusal the gate already explained (`deniedNotice`) carries the
          // precise cause — master switch off, policy, blocked site — which is
          // strictly better than re-deriving "site not authorized" from the
          // origin alone. Name the site too when there is one, so the user
          // knows WHERE it happened as well as why.
          info.deniedNotice !== undefined
            ? (info.browserOrigin ? `${reason} (${info.browserOrigin})` : reason)
            : info.kind === 'browser' && info.browserOrigin
              ? format(t.schedule.denialBrowserSite, { origin: info.browserOrigin })
              : format(t.schedule.denialCommand, { command: info.command }),
        );
      },
    }),
    filePermissionCallback: async (request) => {
      const t = getI18n();
      denials.add(format(t.schedule.denialFile, { path: request.path }));
      return false;
    },
    // request_workspace pops a UI dialog a scheduled run can never answer.
    blockedTools: [TOOL_NAMES.REQUEST_WORKSPACE],
    // Same two values the callback above closes over — see the return type.
    unattendedApproval: {
      ...(imTarget !== null ? { imTarget } : {}),
      runLabel: task.name,
    },
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

    // F1.4 (batch 1, observation only): planned-vs-actual trigger drift.
    // `task.nextRunAt` must be read here, before completeRun/errorRun
    // recompute it for the task's NEXT occurrence — this is the slot that
    // made the task due for THIS run. No nextRunAt (e.g. a bare "run now" on
    // a task not currently due) means there's nothing to compare against.
    // Token cost is intentionally left unset — see docs/plans/
    // 2026-09-01-browser-batch1-observability.md's delivery notes: neither
    // the main agent loop nor ScheduledTask exposes a per-run token figure
    // today (ConversationMeta.totalCost is declared but never written), so
    // this batch reports drift only rather than inventing a ledger.
    if (typeof task.nextRunAt === 'number') {
      const plannedAt = task.nextRunAt;
      safeRecordSchedulerDriftSignal(() => buildSchedulerDriftSignal(task.id, plannedAt, Date.now()));
    }

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

    const authorizationScopeId = createAuthorizationScope(
      resolveEffectivePermissionMode(task) === 'autonomous'
        ? { shell: 'full' }
        : undefined,
    );

    /**
     * U7 — the run report's window boundary (Ruling 2).
     *
     * Captured HERE, before a single tool can fire, and never from a clock:
     * `getBrowserSignalCursor()` is a process-monotonic counter, so the
     * boundary holds across an NTP step, a DST change, and a second run of the
     * same task landing in the same conversation. Slicing by conversation
     * alone would let last night's actions into tonight's report.
     */
    const browserSignalCursor = getBrowserSignalCursor();
    /**
     * What the card will say the run's ending was. Starts at 'error' so an
     * exception thrown anywhere below still produces an honest card rather
     * than none — a run that blew up is exactly the one worth reporting.
     */
    let reportOutcome = browserRunReportOutcomeFor('error', false);
    /**
     * Built ONCE per run, read twice: by the IM summary below (which must go
     * out before the card is appended — see the `finally`) and by the card
     * itself. One aggregation, so the two can never describe the same run
     * differently.
     */
    let report: BrowserRunReportSnapshot | null | undefined;
    try {
      // Everything after scope creation belongs inside this lifecycle owner.
      // Tool discovery and permission initialization can throw synchronously;
      // the finally below must still dispose the scope and release runningTasks.
      const permissions = resolveScheduledRunPermissions(task, authorizationScopeId, conversationId);
      const runPermissionCeiling = buildScheduledRunPermissionCeiling(
        getToolInvoker().getAllTools().map((tool) => tool.name),
      );
      // Builder output is deeply frozen. AgentLoopOptions predates immutable
      // rosters and types this field as mutable, but no consumer mutates it;
      // keep the exact frozen host snapshot at both authorization boundaries.
      const allowedTools = runPermissionCeiling.allowedTools as string[];

      const result = await runAgentLoopDispatched(conversationId, prompt, {
        commandConfirmCallback: permissions.commandConfirmCallback,
        filePermissionCallback: permissions.filePermissionCallback,
        blockedTools: permissions.blockedTools,
        allowedTools,
        authorizationScopeId,
        runPermissionCeiling,
        // F1 — published on the run so the browser gate can ask the task's own
        // chat. The callback above carries the identical values for the gates
        // that DO go through it; this is the same fact, on the channel the
        // browser gate can actually read.
        unattendedApproval: permissions.unattendedApproval,
        // The tick started this run, not a person — unattended even if the
        // user later types into the same conversation (that send is theirs).
        initiatedBy: 'automation',
      });

      const abortedByBrowserDenials =
        result.reason === 'aborted' && result.abortCause === BROWSER_DENIAL_ABORT_CAUSE;
      reportOutcome = browserRunReportOutcomeFor(result.reason, abortedByBrowserDenials);
      report = buildUnattendedBrowserReport({
        conversationId,
        sinceSeq: browserSignalCursor,
        outcome: reportOutcome,
      });
      const runOutcome = deriveUnattendedRunOutcome({
        reason: result.reason,
        abortedByBrowserDenials,
        report,
      });

      // max_turns hit the cap but still produced a usable (partial) answer — deliver
      // it like a completion, just flagged as possibly incomplete, rather than
      // silently dropping the output. (no_progress / error / aborted have no usable
      // output, so they skip the ANSWER below — but not the summary: F7.)
      if (result.reason === 'completed' || result.reason === 'max_turns') {
        const incomplete = result.reason === 'max_turns';
        useScheduleStore.getState().completeRun(task.id, runId);

        // Push results to IM channel if configured
        if (task.outputChannelId) {
          await this.pushToIMChannel(task, conversationId, runOutcome);
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
        // An abort the RUN issued is not the same event as a user pressing
        // Stop, and the run history has to say which: a task that stopped
        // itself after consecutive browser refusals reads as a bare
        // "cancelled" otherwise, and the one fact that explains it — the
        // abort cause — has no reader anywhere.
        const baseError = result.error ?? (
          result.reason === 'aborted'
            ? (result.abortCause === BROWSER_DENIAL_ABORT_CAUSE
              ? getI18n().schedule.abortedBrowserDenials
              : 'Task was cancelled')
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
        /**
         * F7 — the ending reaches the user WHERE THEY ARE.
         *
         * There is no answer to deliver on this branch (that is why it does
         * not extract the conversation's last message), but "no usable
         * output" and "say nothing" were wrongly the same decision: a task
         * bound to an IM channel used to go completely silent on every
         * failing terminal, which in IM is indistinguishable from never
         * having run. The desktop notification below is not a substitute —
         * 9am unattended runs exist precisely because nobody is at the
         * machine.
         */
        if (task.outputChannelId) {
          await this.pushOutcomeToIMChannel(task, runOutcome);
        }
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
      // Same F7 reasoning as the else branch above. `reportOutcome` is still
      // the 'error' it was initialized to, which is exactly what this is.
      report = buildUnattendedBrowserReport({
        conversationId,
        sinceSeq: browserSignalCursor,
        outcome: reportOutcome,
      });
      if (task.outputChannelId) {
        await this.pushOutcomeToIMChannel(
          task,
          deriveUnattendedRunOutcome({
            reason: 'error',
            abortedByBrowserDenials: false,
            report,
          }),
        );
      }
      notifyScheduledTaskError(task.name);
      const t = getI18n();
      useToastStore.getState().addToast({
        type: 'error',
        title: format(t.schedule.taskError, { name: task.name }),
        message: errorMsg.slice(0, 100),
      });
      console.error(`[Scheduler] Task error: ${task.name}`, err);
    } finally {
      /**
       * U7 — the morning report.
       *
       * In `finally` on purpose, for two reasons. It runs for EVERY terminal:
       * a run that failed, was stopped, or aborted itself after repeated
       * refusals is precisely the run the user needs an explanation for, and
       * only the success branch used to write anything into the conversation
       * at all. And it runs AFTER `pushToIMChannel`, whose `last_message`
       * extraction would otherwise pick up this (deliberately text-less) card
       * instead of the answer the task produced.
       *
       * Emits nothing when the run never touched the browser.
       *
       * F7 — the snapshot itself was built earlier (in `try`, or in `catch`),
       * because the IM summary is derived from it and has to go out before
       * this line appends the card. Same object, both surfaces.
       */
      appendBrowserRunReportMessage({ conversationId, report: report ?? null });
      disposeAuthorizationScope(authorizationScopeId);
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

  private async pushToIMChannel(
    task: ScheduledTask,
    conversationId: string,
    outcome: UnattendedRunOutcome,
  ) {
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

    const answer = outputSender.buildMessage(conversationId, baseOutput, context);
    /**
     * F7 — ONE line in front of the answer, never more. A run that worked is
     * the common case and it is being read on a phone; the ending belongs at
     * the top, the reasoning does not belong at all.
     */
    const message: AbuMessage = {
      ...answer,
      content: `${formatUnattendedOutcomeSummary(outcome, getI18n())}\n\n${answer.content}`,
    };

    await this.sendToTaskChats(task, baseOutput, message);
  }

  /**
   * F7 — the ending, with no answer attached.
   *
   * Used by every terminal that produces nothing to deliver (error, stopped,
   * no progress, and the outer catch). It deliberately does NOT read the
   * conversation: `last_message` on a failed run pulls whatever half-thought
   * the model stopped on, which reads like an answer and is not one. The
   * summary is built from closed codes and local counts only.
   *
   * Never throws: it is called from the failure paths, including the catch
   * block, and a notification about a failure must not become a second one.
   */
  private async pushOutcomeToIMChannel(task: ScheduledTask, outcome: UnattendedRunOutcome) {
    try {
      const color: MessageColor = outcome.code === 'stopped' ? 'info' : 'warning';
      const message: AbuMessage = {
        content: formatUnattendedOutcomeSummary(outcome, getI18n()),
        title: task.name,
        color,
        footer: `Abu AI · ${new Date().toLocaleString('zh-CN')}`,
      };
      await this.sendToTaskChats(
        task,
        {
          enabled: true as const,
          target: 'im_channel' as const,
          outputChannelId: task.outputChannelId,
          extractMode: 'last_message' as const,
        },
        message,
        { quiet: true },
      );
    } catch (err) {
      console.warn(`[Scheduler] Outcome push failed for ${task.name}`, err);
    }
  }

  /** Send one built message to every chat / user the task names. */
  private async sendToTaskChats(
    task: ScheduledTask,
    baseOutput: {
      enabled: true;
      target: 'im_channel';
      outputChannelId: string | undefined;
      extractMode: 'last_message';
    },
    message: AbuMessage,
    options: { quiet?: boolean } = {},
  ) {
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
      // `quiet` for the outcome-only push: the run already raised its own
      // failure toast and desktop notification, and a second red toast saying
      // the failure NOTICE failed is noise stacked on noise.
      if (!options.quiet) {
        const t = getI18n();
        useToastStore.getState().addToast({
          type: 'error',
          title: format(t.schedule.taskCompleted, { name: task.name }),
          message: t.schedule.outputPushFailed,
        });
      }
    }
  }
}

// Singleton instance
export const schedulerEngine = new SchedulerEngine();
