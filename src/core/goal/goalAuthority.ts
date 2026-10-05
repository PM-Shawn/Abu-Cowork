import type { Conversation, ToolExecutionContext } from '@/types';
import { GOAL_BLOCK_AFTER_ROUNDS, type GoalState } from './goalTypes';

/**
 * Runtime authority for the model-facing goal tool — checked in code, not
 * left to the prompt (same stance as DSH's tool-goal/authority.ts).
 *
 * - Only the conversation's own loop may touch the goal: never a delegated
 *   subagent or team member (`agentRunId` is stamped by the trusted runtime).
 * - Creating, editing, pausing or resuming needs a human-initiated run: a
 *   real user message in this very run. An automatic goal round cannot
 *   re-scope, extend or restart its own goal.
 * - Complete / block are allowed in either kind of run; block only after
 *   GOAL_BLOCK_AFTER_ROUNDS rounds so "hard" is not reported as "blocked".
 */

export type GoalToolAction = 'get' | 'create' | 'edit' | 'pause' | 'resume' | 'complete' | 'block';

export type GoalAuthorityDenial =
  | 'subagent'
  | 'automated-conversation'
  | 'needs-human-turn'
  | 'block-too-early';

/** Scheduled tasks, triggers and IM channels have their own run envelopes; goal mode stays out of them. */
export function isGoalEligibleConversation(conversation: Pick<Conversation, 'scheduledTaskId' | 'triggerId' | 'imChannelId' | 'readOnly'>): boolean {
  return !conversation.scheduledTaskId && !conversation.triggerId && !conversation.imChannelId && !conversation.readOnly;
}

/** Whether this run was started by a human message (and is not an automatic goal round). */
export function isHumanInitiatedRun(
  context: Pick<ToolExecutionContext, 'initiatedBy' | 'interactionMode' | 'loopId'>,
  conversation: Pick<Conversation, 'messages'>,
): boolean {
  if (context.initiatedBy !== 'user' || context.interactionMode === 'background' || !context.loopId) return false;
  return conversation.messages.some((message) =>
    message.role === 'user'
    && message.loopId === context.loopId
    && !message.isSystem
    && !message.goalRound);
}

export function checkGoalAuthority(
  action: GoalToolAction,
  context: Pick<ToolExecutionContext, 'agentRunId' | 'initiatedBy' | 'interactionMode' | 'loopId'>,
  conversation: Pick<Conversation, 'messages' | 'scheduledTaskId' | 'triggerId' | 'imChannelId' | 'readOnly'>,
  goal: GoalState | undefined,
): GoalAuthorityDenial | undefined {
  if (context.agentRunId) return 'subagent';
  if (action === 'get') return undefined;
  if (!isGoalEligibleConversation(conversation)) return 'automated-conversation';
  switch (action) {
    case 'create':
    case 'edit':
    case 'pause':
    case 'resume':
      return isHumanInitiatedRun(context, conversation) ? undefined : 'needs-human-turn';
    case 'complete':
      return undefined;
    case 'block':
      return goal && goal.roundsStarted < GOAL_BLOCK_AFTER_ROUNDS ? 'block-too-early' : undefined;
  }
}
