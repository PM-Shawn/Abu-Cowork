import { useChatStore } from '@/stores/chatStore';
import { onDispatchSettled, runAgentLoopDispatched, type AgentLoopDispatchResult } from '@/core/agent/agentLoopRunner';
import { isConversationRunningInSidecar } from '@/core/agent/sidecarRunPredicate';
import { getQueuedInputs } from '@/core/agent/userInputQueue';
import { TOOL_NAMES } from '@/core/tools/toolNames';
import { getI18n, format } from '@/i18n';
import { notifyGoalBlocked } from '@/utils/notifications';
import type { Conversation, Message } from '@/types';
import { getGoalActivation, isGoalArmed, resetGoalRetries, setGoalRetry } from './goalActivation';
import { isGoalEligibleConversation } from './goalAuthority';
import { buildGoalRoundPrompt } from './goalPrompt';
import {
  blockConversationGoal,
  disarmConversationGoal,
  pauseConversationGoal,
  recordConversationGoalRound,
  startConversationGoalRound,
  suspendConversationGoalClock,
} from './goalService';
import {
  GOAL_MAX_IDLE_ROUNDS,
  GOAL_RETRY_DELAYS_MS,
  GOAL_TEAM_MAX_DISPATCHES,
  goalRef,
  type GoalBlockedCode,
  type GoalState,
} from './goalTypes';

/**
 * Goal mode's round driver: after a dispatch settles (the run and every
 * queued user follow-up are done), decide whether the conversation's goal
 * gets another automatic round.
 *
 * One round = one independent run via `runAgentLoopDispatched(..., {
 * requireNewRun })` — the same path the max-turns "continue" card and the
 * scheduler use — so the per-run turn cap, no-progress guard, crash
 * checkpoint and execution panel all keep working per round, and nothing in
 * the agent loop's own stop logic changes.
 *
 * A round that ends in an error is retried after GOAL_RETRY_DELAYS_MS (one
 * wait per attempt) unless the error cannot succeed on a retry; once the
 * attempts are spent the goal is DISARMED (it stays active; the user resumes
 * it). The user pressing Stop pauses it.
 */

// ── Pure decision ────────────────────────────────────────────────────────

export type GoalSettleDecision =
  | { kind: 'ignore' }
  | { kind: 'wait' }
  | { kind: 'disarm'; reason: 'run-error' }
  | { kind: 'retry'; attempt: number; delayMs: number }
  | { kind: 'pause' }
  | { kind: 'block'; code: GoalBlockedCode }
  | { kind: 'continue' };

export interface GoalSettleInput {
  goal: GoalState | undefined;
  armed: boolean;
  reason: AgentLoopDispatchResult['reason'];
  eligible: boolean;
  isTeam: boolean;
  /** `reason: 'error'` only: whether running again could succeed. */
  retryable: boolean;
  /** Automatic retries already made since the last round that did not fail. */
  retriesUsed: number;
}

/**
 * Whether a failed run is worth running again. A request the provider
 * rejected as invalid (4xx other than timeout / rate limit) or one too large
 * to send fails the same way every time.
 */
export function isRetryableRunError(result: Pick<AgentLoopDispatchResult, 'stopReason' | 'upstream'>): boolean {
  if (result.stopReason === 'payload_too_large') return false;
  const status = result.upstream?.status;
  if (status === undefined) return true;
  if (status === 408 || status === 429) return true;
  return status < 400 || status >= 500;
}

/**
 * What to do with the goal after a dispatch settled. The round outcome
 * (idle streak, team hand-offs) must already be recorded on `goal`.
 */
export function decideAfterSettle(input: GoalSettleInput): GoalSettleDecision {
  const { goal } = input;
  if (!goal || goal.phase !== 'active' || !input.armed) return { kind: 'ignore' };
  switch (input.reason) {
    // Nothing ran — this call only queued its text into a live run, whose
    // own settle will drive the goal.
    case 'enqueued':
      return { kind: 'ignore' };
    // A trusted tool is waiting on the user (plan approval, recovery choice).
    // Stay armed; the run that follows the user's answer settles again.
    case 'awaiting_user':
      return { kind: 'wait' };
    case 'aborted':
      return { kind: 'pause' };
    case 'error': {
      const delayMs = GOAL_RETRY_DELAYS_MS[input.retriesUsed];
      if (!input.retryable || !input.eligible || delayMs === undefined || goal.roundsStarted >= goal.maxRounds) {
        return { kind: 'disarm', reason: 'run-error' };
      }
      return { kind: 'retry', attempt: input.retriesUsed + 1, delayMs };
    }
    case 'completed':
    case 'max_turns':
    case 'no_progress':
      break;
  }
  if (!input.eligible) return { kind: 'ignore' };
  if (goal.consecutiveIdleRounds >= GOAL_MAX_IDLE_ROUNDS) return { kind: 'block', code: 'no-progress' };
  if (input.isTeam && (goal.teamDispatches ?? 0) >= GOAL_TEAM_MAX_DISPATCHES) {
    return { kind: 'block', code: 'team-dispatch-limit' };
  }
  if (goal.roundsStarted >= goal.maxRounds) return { kind: 'block', code: 'round-limit' };
  return { kind: 'continue' };
}

/** Tool calls and team member hand-offs made in `messages`. */
export function summarizeRoundMessages(messages: readonly Message[]): { hadToolCalls: boolean; teamDispatches: number } {
  let toolCalls = 0;
  let teamDispatches = 0;
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.toolCalls) continue;
    for (const call of message.toolCalls) {
      // manage_goal itself is bookkeeping, not progress on the objective.
      if (call.name === TOOL_NAMES.MANAGE_GOAL) continue;
      toolCalls += 1;
      if (call.name === TOOL_NAMES.DELEGATE_TO_AGENT) teamDispatches += 1;
      if (call.name === TOOL_NAMES.RUN_AGENT_BATCH) {
        const tasks = (call.input as { tasks?: unknown } | undefined)?.tasks;
        teamDispatches += Array.isArray(tasks) ? tasks.length : 1;
      }
    }
  }
  return { hadToolCalls: toolCalls > 0, teamDispatches };
}

// ── Effects ──────────────────────────────────────────────────────────────

/** The automatic round in flight per conversation: where its messages start. */
const inFlightRounds = new Map<string, { goalId: string; startIndex: number }>();

/** Start the next round after `delayMs`, unless the goal was paused, resumed or cleared meanwhile. */
function scheduleRetry(conversationId: string, goalId: string, attempt: number, delayMs: number): void {
  const at = Date.now() + delayMs;
  suspendConversationGoalClock(conversationId);
  setGoalRetry(conversationId, goalId, { attempt, at });
  setTimeout(() => {
    const pending = getGoalActivation(conversationId, goalId)?.retry;
    if (!pending || pending.attempt !== attempt || pending.at !== at) return;
    setGoalRetry(conversationId, goalId, undefined);
    void startNextRound(conversationId);
  }, delayMs);
}

function blockedMessage(code: GoalBlockedCode, goal: GoalState): string {
  switch (code) {
    case 'no-progress':
      return `${GOAL_MAX_IDLE_ROUNDS} rounds in a row ended without any tool call or completion.`;
    case 'team-dispatch-limit':
      return `The goal used its ${GOAL_TEAM_MAX_DISPATCHES} expert hand-offs.`;
    case 'round-limit':
      return `The goal used all ${goal.maxRounds} rounds.`;
    default:
      return '';
  }
}

function canStartRoundNow(conversationId: string, conversation: Conversation): boolean {
  if (conversation.status === 'running' || isConversationRunningInSidecar(conversationId)) return false;
  // A human follow-up waits in the queue — it goes first; its own settle re-drives.
  return getQueuedInputs(conversationId).length === 0;
}

async function startNextRound(conversationId: string): Promise<void> {
  const conversation = useChatStore.getState().conversations[conversationId];
  const goal = conversation?.goal;
  if (!conversation || !goal || goal.phase !== 'active' || !isGoalArmed(conversationId, goal.id)) return;
  if (!canStartRoundNow(conversationId, conversation)) return;

  const started = startConversationGoalRound(conversationId, goalRef(goal));
  if (!started.ok) return;
  const round = started.goal.roundsStarted;
  inFlightRounds.set(conversationId, { goalId: started.goal.id, startIndex: conversation.messages.length });
  try {
    await runAgentLoopDispatched(conversationId, buildGoalRoundPrompt(started.goal, round), {
      requireNewRun: true,
      initiatedBy: 'user',
      goalRound: { goalId: started.goal.id, revision: started.goal.revision, round },
    });
  } catch {
    // A dispatch that threw after its run settled was already handled at the
    // settle seam, which may have scheduled a retry. One that threw before
    // settling never got there: stop automatic rounds; the goal stays active
    // for the user.
    if (inFlightRounds.get(conversationId)?.goalId === started.goal.id) inFlightRounds.delete(conversationId);
    if (!getGoalActivation(conversationId, started.goal.id)?.retry) disarmConversationGoal(conversationId, 'run-error');
  }
}

/** Handle one settled dispatch. Exported for tests; production wires it through installGoalDriver. */
export function handleDispatchSettled(conversationId: string, result: AgentLoopDispatchResult): void {
  if (result.reason === 'enqueued') return;
  const conversation = useChatStore.getState().conversations[conversationId];
  const inFlight = inFlightRounds.get(conversationId);
  inFlightRounds.delete(conversationId);
  let goal = conversation?.goal;
  if (!conversation || !goal) return;

  // Record what the finished goal round did before deciding on the next one.
  if (inFlight && inFlight.goalId === goal.id && goal.phase === 'active') {
    const summary = summarizeRoundMessages(conversation.messages.slice(inFlight.startIndex));
    const recorded = recordConversationGoalRound(conversationId, goalRef(goal), {
      // The loop's own no-progress guard means the round was spinning, even
      // if it called tools; a round cut by the turn cap was clearly working.
      hadToolCalls: result.reason === 'no_progress'
        ? false
        : summary.hadToolCalls || result.reason === 'max_turns',
      teamDispatches: summary.teamDispatches,
    });
    if (recorded.ok) goal = recorded.goal;
  }

  // Whatever settles here supersedes a retry that was still waiting, and any
  // run that did not fail ends the retry streak. The count lives on the
  // activation, so pausing, resuming or re-arming the goal ends it too.
  if (result.reason === 'error') setGoalRetry(conversationId, goal.id, undefined);
  else resetGoalRetries(conversationId, goal.id);

  const decision = decideAfterSettle({
    goal,
    armed: isGoalArmed(conversationId, goal.id),
    reason: result.reason,
    eligible: isGoalEligibleConversation(conversation),
    isTeam: Boolean(conversation.teamId),
    retryable: isRetryableRunError(result),
    retriesUsed: getGoalActivation(conversationId, goal.id)?.retriesUsed ?? 0,
  });

  switch (decision.kind) {
    case 'ignore':
    case 'wait':
      return;
    case 'disarm':
      disarmConversationGoal(conversationId, decision.reason);
      return;
    case 'retry':
      scheduleRetry(conversationId, goal.id, decision.attempt, decision.delayMs);
      return;
    case 'pause':
      pauseConversationGoal(conversationId, goalRef(goal));
      return;
    case 'block': {
      const blocked = blockConversationGoal(conversationId, goalRef(goal), { code: decision.code, message: blockedMessage(decision.code, goal) });
      // The round's own completion notice was held back while the goal was
      // driving; this is the one that tells the user it stopped.
      if (blocked.ok) void notifyGoalBlocked(format(getI18n().chat.goal.notifyBlockedTitle, { objective: goal.objective }), conversationId);
      return;
    }
    case 'continue':
      // Next macrotask: let the settling dispatch finish unwinding first.
      setTimeout(() => { void startNextRound(conversationId); }, 0);
      return;
  }
}

/**
 * Kick off the first automatic round right after the user creates or resumes
 * a goal from the UI / command while the conversation is idle. (A goal the
 * model creates mid-run needs no kick: that run's settle starts round 1.)
 */
export function kickGoalDriver(conversationId: string): void {
  setTimeout(() => { void startNextRound(conversationId); }, 0);
}

let uninstall: (() => void) | undefined;

/** Register the driver on the dispatch seam. Idempotent; call once at app start. */
export function installGoalDriver(): () => void {
  if (!uninstall) uninstall = onDispatchSettled(handleDispatchSettled);
  return () => {
    uninstall?.();
    uninstall = undefined;
  };
}

/** Test-only reset. */
export function resetGoalDriverForTest(): void {
  inFlightRounds.clear();
  uninstall?.();
  uninstall = undefined;
}
