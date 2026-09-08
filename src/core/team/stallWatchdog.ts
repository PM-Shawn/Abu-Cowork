import { useChatStore } from '@/stores/chatStore';
import { useTaskExecutionStore } from '@/stores/taskExecutionStore';
import { useToastStore } from '@/stores/toastStore';
import { collectMemberDispatches } from '@/components/team/teamDispatches';
import { requestDispatchCancel } from '@/core/agent/dispatchCancel';
import { notifyTeamStallStopped } from '@/utils/notifications';
import { getI18n, format } from '@/i18n';

/**
 * Stall watchdog for team hand-offs (block Q): lease-expiry semantics — a
 * running member whose last step is older than STALL_STOP_MINUTES is stopped
 * (only that hand-off), the user is told, and the abort reason travels with
 * the member's result so the leader re-dispatches once. Heartbeat, not wall
 * clock: a member that keeps producing steps is never stopped, however long
 * it takes (BullMQ stalled jobs / Temporal heartbeat; no harness kills on
 * elapsed time). Shell-only: reads the live execution store.
 */
import { STALL_STOP_MINUTES } from './stallThreshold';

export { STALL_STOP_MINUTES };
export const STALL_CHECK_INTERVAL_MS = 60_000;

export interface StalledDispatch {
  conversationId: string;
  key: string;
  agent: string;
  minutes: number;
}

/** Live running hand-offs of team conversations with no new step for STALL_STOP_MINUTES. */
export function findStalledDispatches(now: number): StalledDispatch[] {
  const chat = useChatStore.getState();
  const executions = Object.values(useTaskExecutionStore.getState().executions);
  const runningConversations = new Set(executions.filter((exec) => exec.status === 'running').map((exec) => exec.conversationId));
  const stalled: StalledDispatch[] = [];
  for (const conversationId of runningConversations) {
    const conversation = chat.conversations[conversationId];
    if (!conversation?.teamId) continue;
    for (const dispatch of collectMemberDispatches({ conversationId, executions, messages: conversation.messages })) {
      if (!dispatch.live || dispatch.status !== 'running' || dispatch.lastActivityAt === undefined) continue;
      const minutes = Math.floor((now - dispatch.lastActivityAt) / 60_000);
      if (minutes >= STALL_STOP_MINUTES) stalled.push({ conversationId, key: dispatch.key, agent: dispatch.agent, minutes });
    }
  }
  return stalled;
}

// Keys already stopped this session, so a hand-off that takes a moment to
// settle is not stopped twice; pruned to keys still reported as stalled.
let stoppedKeys = new Set<string>();

/** One sweep: stop every newly stalled hand-off. Returns how many were stopped. */
export function runStallCheck(now: number = Date.now()): number {
  const stalled = findStalledDispatches(now);
  const next = new Set<string>();
  let stopped = 0;
  const t = getI18n();
  for (const entry of stalled) {
    next.add(entry.key);
    if (stoppedKeys.has(entry.key)) continue;
    stopped += 1;
    requestDispatchCancel(entry.key, format(t.chat.subagent.stalledStopped, { n: entry.minutes }));
    const title = format(t.team.stallStoppedNotice, { member: entry.agent, n: entry.minutes });
    notifyTeamStallStopped(title, entry.conversationId);
    try {
      useToastStore.getState().addToast({ type: 'warning', title });
    } catch {
      // Toasts are best-effort.
    }
  }
  stoppedKeys = next;
  return stopped;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Idempotent; runs alongside the scheduler for the app's lifetime. */
export function startTeamStallWatchdog(): void {
  if (timer) return;
  timer = setInterval(() => {
    try {
      runStallCheck();
    } catch (err) {
      console.warn('[TeamStallWatchdog] sweep failed', err);
    }
  }, STALL_CHECK_INTERVAL_MS);
}

export function stopTeamStallWatchdog(): void {
  if (timer) clearInterval(timer);
  timer = null;
  stoppedKeys = new Set();
}
