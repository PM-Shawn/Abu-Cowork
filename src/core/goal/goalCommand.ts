import { useChatStore } from '@/stores/chatStore';
import { getI18n, format } from '@/i18n';
import { isGoalEligibleConversation } from './goalAuthority';
import { kickGoalDriver } from './goalDriver';
import {
  clearConversationGoal,
  createConversationGoal,
  editConversationGoal,
  getGoal,
  pauseConversationGoal,
  resumeConversationGoal,
} from './goalService';
import type { GoalTransitionResult } from './goalTransitions';
import { GOAL_DEFAULT_MAX_ROUNDS, goalRef, type GoalPhase } from './goalTypes';

/**
 * `/goal` — the human side of goal mode (same grammar as Codex / DSH):
 *
 *   /goal                  show the current goal
 *   /goal <objective>      set a goal and start working on it
 *   /goal edit <objective> replace the objective
 *   /goal pause | resume | clear
 *
 * Handled in the composer before any dispatch, so it never reaches the model
 * and costs no tokens (like /compact).
 */

export type GoalCommand =
  | { kind: 'status' }
  | { kind: 'create'; objective: string }
  | { kind: 'edit'; objective: string }
  | { kind: 'pause' }
  | { kind: 'resume'; extraRounds?: number }
  | { kind: 'clear' };

/** Parse `/goal …`; null when the text is not a /goal command. */
export function parseGoalCommand(text: string): GoalCommand | null {
  const match = /^\/goal(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  const rest = (match[1] ?? '').trim();
  if (!rest) return { kind: 'status' };
  const [word, ...tail] = rest.split(/\s+/);
  const lower = word.toLowerCase();
  const tailText = rest.slice(word.length).trim();
  if (tail.length === 0 && lower === 'pause') return { kind: 'pause' };
  if (tail.length === 0 && lower === 'clear') return { kind: 'clear' };
  if (lower === 'resume' && tail.length <= 1) {
    if (tail.length === 0) return { kind: 'resume' };
    const extra = Number(tailText.replace(/^\+/, ''));
    if (Number.isInteger(extra) && extra > 0) return { kind: 'resume', extraRounds: extra };
  }
  if (lower === 'edit') return { kind: 'edit', objective: tailText };
  return { kind: 'create', objective: rest };
}

export interface GoalCommandOutcome {
  ok: boolean;
  message: string;
}

function phaseLabel(phase: GoalPhase): string {
  const t = getI18n().chat.goal;
  switch (phase) {
    case 'active': return t.phaseActive;
    case 'paused': return t.phasePaused;
    case 'blocked': return t.phaseBlocked;
    case 'complete': return t.phaseComplete;
  }
}

export function describeTransitionFailure(result: Extract<GoalTransitionResult, { ok: false }>, maxRounds = GOAL_DEFAULT_MAX_ROUNDS): string {
  const t = getI18n().chat.goal;
  switch (result.error) {
    case 'no-goal': return t.noGoal;
    case 'stale-revision': return t.staleRevision;
    case 'empty-objective': return t.emptyObjective;
    case 'rounds-exhausted': return format(t.roundsExhausted, { maxRounds });
    case 'missing-evidence':
    case 'invalid-transition':
      return format(t.cannotChange, { phase: result.phase ? phaseLabel(result.phase) : '' });
  }
}

/** Whether `/goal <objective>` may create a goal here (checked before the conversation even exists). */
export function checkGoalCreatable(conversationId: string | undefined, objective: string): GoalCommandOutcome {
  const t = getI18n().chat.goal;
  if (!objective.trim()) return { ok: false, message: t.emptyObjective };
  if (!conversationId) return { ok: true, message: '' };
  const conversation = useChatStore.getState().conversations[conversationId];
  if (conversation && !isGoalEligibleConversation(conversation)) return { ok: false, message: t.notAvailable };
  const goal = conversation?.goal;
  if (goal && goal.phase !== 'complete') return { ok: false, message: format(t.alreadyExists, { objective: goal.objective }) };
  return { ok: true, message: '' };
}

/** Create the goal (the caller then sends the objective as the first message of round 0). */
export function createGoalFromCommand(conversationId: string, objective: string, maxRounds?: number): GoalCommandOutcome {
  const t = getI18n().chat.goal;
  const precheck = checkGoalCreatable(conversationId, objective);
  if (!precheck.ok) return precheck;
  const result = createConversationGoal(conversationId, { objective, maxRounds });
  if (!result.ok) return { ok: false, message: describeTransitionFailure(result) };
  return { ok: true, message: format(t.created, { objective: result.goal.objective, maxRounds: result.goal.maxRounds }) };
}

/** Run every /goal form except create, which needs the send path. */
export function applyGoalCommand(conversationId: string | undefined, command: Exclude<GoalCommand, { kind: 'create' }>): GoalCommandOutcome {
  const t = getI18n().chat.goal;
  const goal = conversationId ? getGoal(conversationId) : undefined;
  if (!conversationId || !goal) return { ok: command.kind === 'status', message: t.noGoal };

  let result: GoalTransitionResult;
  switch (command.kind) {
    case 'status':
      return {
        ok: true,
        message: format(t.status, {
          objective: goal.objective,
          phase: phaseLabel(goal.phase),
          rounds: goal.roundsStarted,
          maxRounds: goal.maxRounds,
        }),
      };
    case 'edit':
      if (!command.objective.trim()) return { ok: false, message: t.emptyObjective };
      result = editConversationGoal(conversationId, goalRef(goal), command.objective);
      return result.ok ? { ok: true, message: t.edited } : { ok: false, message: describeTransitionFailure(result) };
    case 'pause': {
      result = pauseConversationGoal(conversationId, goalRef(goal));
      if (!result.ok) return { ok: false, message: describeTransitionFailure(result) };
      // A human pause stops the round in flight, like DSH's host pause.
      const conversation = useChatStore.getState().conversations[conversationId];
      if (conversation?.status === 'running') useChatStore.getState().cancelStreaming(conversationId);
      return { ok: true, message: t.paused };
    }
    case 'resume':
      result = resumeConversationGoal(conversationId, goalRef(goal), command.extraRounds);
      if (!result.ok) return { ok: false, message: describeTransitionFailure(result, goal.maxRounds) };
      kickGoalDriver(conversationId);
      return { ok: true, message: t.resumed };
    case 'clear':
      result = clearConversationGoal(conversationId, goalRef(goal));
      return result.ok ? { ok: true, message: t.cleared } : { ok: false, message: describeTransitionFailure(result) };
  }
}
