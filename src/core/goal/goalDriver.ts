import { useChatStore } from '@/stores/chatStore';
import { onDispatchSettled, runAgentLoopDispatched, type AgentLoopDispatchResult } from '@/core/agent/agentLoopRunner';
import { isConversationRunningInSidecar } from '@/core/agent/sidecarRunPredicate';
import { getQueuedInputs } from '@/core/agent/userInputQueue';
import { TOOL_NAMES } from '@/core/tools/toolNames';
import { getI18n, format } from '@/i18n';
import { notifyGoalBlocked } from '@/utils/notifications';
import type { Conversation, Message } from '@/types';
import { isGoalArmed } from './goalActivation';
import { isGoalEligibleConversation } from './goalAuthority';
import { buildGoalRoundPrompt } from './goalPrompt';
import {
  blockConversationGoal,
  disarmConversationGoal,
  pauseConversationGoal,
  recordConversationGoalRound,
  startConversationGoalRound,
} from './goalService';
import {
  GOAL_MAX_IDLE_ROUNDS,
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
 * Error handling follows DSH's driver: an error, output-token exhaustion or a
 * failed dispatch only DISARMS (the goal stays active; the user resumes it);
 * the user pressing Stop pauses it.
 */

// ── Pure decision ────────────────────────────────────────────────────────

export type GoalSettleDecision =
  | { kind: 'ignore' }
  | { kind: 'wait' }
  | { kind: 'disarm'; reason: 'run-error' }
  | { kind: 'pause' }
  | { kind: 'block'; code: GoalBlockedCode }
  | { kind: 'continue' };

export interface GoalSettleInput {
  goal: GoalState | undefined;
  armed: boolean;
  reason: AgentLoopDispatchResult['reason'];
  eligible: boolean;
  isTeam: boolean;
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
    case 'error':
      return { kind: 'disarm', reason: 'run-error' };
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
    // A dispatch that threw before its run settled never reached the settle
    // seam. Stop automatic rounds; the goal stays active for the user.
    if (inFlightRounds.get(conversationId)?.goalId === started.goal.id) inFlightRounds.delete(conversationId);
    disarmConversationGoal(conversationId, 'run-error');
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

  const decision = decideAfterSettle({
    goal,
    armed: isGoalArmed(conversationId, goal.id),
    reason: result.reason,
    eligible: isGoalEligibleConversation(conversation),
    isTeam: Boolean(conversation.teamId),
  });

  switch (decision.kind) {
    case 'ignore':
    case 'wait':
      return;
    case 'disarm':
      disarmConversationGoal(conversationId, decision.reason);
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
