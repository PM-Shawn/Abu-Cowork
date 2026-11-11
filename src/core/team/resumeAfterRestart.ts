import { useChatStore } from '@/stores/chatStore';
import { runAgentLoopDispatched, type AgentLoopDispatchResult } from '@/core/agent/agentLoopRunner';
import { getMessageText } from '@/core/context/contextUtils';
import { getI18n, format } from '@/i18n';
import { steeredTextsOf } from '@/utils/steeredTurn';

const MAX_REQUEST_CHARS = 500;

/**
 * Continue a team run the application closed on. Started by the user's click
 * on the interrupted row (block R): the leader picks up from what the
 * conversation already holds instead of running the turn again.
 *
 * Opening the app authorizes nothing — the startup checkpoint sweep only
 * marks the row, exactly as the goal driver leaves a restored goal disarmed
 * until the user resumes it. The click is a human send, so the run keeps the
 * conversation's own permission mode and dialogs and is dispatched as
 * `initiatedBy: 'user'`; its outcome shows on the row it appends, like any
 * other send. Returns null when there is nothing to continue: a conversation
 * without a team, a read-only import, or no user request on record.
 */
export async function resumeTeamRunAfterRestart(conversationId: string): Promise<AgentLoopDispatchResult | null> {
  const conversation = useChatStore.getState().conversations[conversationId];
  if (!conversation?.teamId || conversation.readOnly) return null;
  // The last request, not a message steered into its run; what was steered
  // into the run belongs to the request. Each part is cut on its own, so a
  // long request never pushes the corrections steered into it out of the quote.
  const lastUser = [...conversation.messages].reverse().find((m) => m.role === 'user' && !m.isSystem && !m.steered);
  if (!lastUser) return null;
  const request = [getMessageText(lastUser.content), ...steeredTextsOf(conversation.messages, lastUser)]
    .map((part) => part.trim().slice(0, MAX_REQUEST_CHARS).trim())
    .filter((part) => part.length > 0)
    .join('\n\n');
  if (!request) return null;
  return runAgentLoopDispatched(
    conversationId,
    format(getI18n().team.resumeAfterRestart, { request }),
    { initiatedBy: 'user' },
  );
}
