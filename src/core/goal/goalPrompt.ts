import { getConversationReader } from '@/core/agent/ports/conversationReader';
import type { GoalState } from './goalTypes';

/**
 * LLM-facing goal text (English, per the prompt-language rule; the reply
 * language is still set by the response-language section).
 *
 * The per-turn block rides the volatile context tail — never the system
 * prompt — so a round counter ticking up never invalidates the cached prefix.
 * It goes through `sanitizeTailBody` with the rest of the tail, which matters
 * because the objective is user-authored text.
 */

function activeBlock(goal: GoalState): string {
  return [
    `## Active goal (rounds used: ${goal.roundsStarted} of ${goal.maxRounds})`,
    `Objective: ${goal.objective}`,
    'The app starts a new round automatically after this run ends, until the goal is completed, blocked, paused by the user, or out of rounds.',
    'If the user\'s own message asks to continue or resume the goal, call manage_goal with action "resume" first: automatic rounds may have stopped after an app restart or an error.',
    'Keep working toward the objective. Before claiming completion, verify the WHOLE objective against the workspace and tool results, then call manage_goal with action "complete" and concrete evidence. Partial progress is not completion.',
  ].join('\n');
}

function wrapUpBlock(goal: GoalState): string {
  const outcome = goal.phase === 'complete' ? 'complete' : 'blocked';
  return [
    `## Goal ${outcome}`,
    `Objective: ${goal.objective}`,
    `The goal is now marked ${outcome}. Write a short closing note for the user: what was done, how it was verified, and where the deliverables are${outcome === 'blocked' ? ', and exactly what is needed from the user to continue' : ''}.`,
    "Report only what this conversation's tool results actually establish. Do not call any more tools in this run.",
  ].join('\n');
}

/**
 * The goal block for one model turn, or '' when there is nothing to say.
 * `loopId` scopes the wrap-up to the run that settled the goal.
 */
export function formatGoalForPrompt(conversationId: string, loopId?: string): string {
  const goal = getConversationReader().getConversation(conversationId)?.goal;
  if (!goal) return '';
  switch (goal.phase) {
    case 'active':
      return activeBlock(goal);
    case 'complete':
    case 'blocked':
      if (loopId && goal.settledLoopId === loopId) return wrapUpBlock(goal);
      if (goal.phase === 'blocked') {
        return `## Goal blocked (waiting for the user)\nObjective: ${goal.objective}\nIf the user's message resolves the blocker or asks to continue, call manage_goal with action "resume" and keep working on the objective.`;
      }
      return '';
    case 'paused':
      return `## Goal paused by the user\nObjective: ${goal.objective}\nAutomatic rounds are paused. If the user's message asks to continue the goal, call manage_goal with action "resume" and keep working on it; otherwise just answer the message.`;
  }
}

/** Round-start message for an automatic goal round (hidden from the chat as a user bubble). */
export function buildGoalRoundPrompt(goal: GoalState, round: number): string {
  return [
    `<goal_round round="${round}" max="${goal.maxRounds}">`,
    'Continue working toward the active goal in this same conversation. Treat the workspace and earlier tool results as the source of truth and re-check them before acting. If work remains, keep going. If the whole objective is achieved, gather evidence and mark the goal complete.',
    '</goal_round>',
  ].join('\n');
}
