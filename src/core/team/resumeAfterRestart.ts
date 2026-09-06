import { useChatStore } from '@/stores/chatStore';
import { runAgentLoopDispatched } from '@/core/agent/agentLoopRunner';
import { getMessageText } from '@/core/context/contextUtils';
import { getI18n, format } from '@/i18n';

const MAX_REQUEST_CHARS = 500;

/**
 * Restart recovery for team conversations (block R): when an orphaned crash
 * checkpoint shows a team run was cut mid-way, continue it automatically
 * from where it stopped instead of waiting for the user (Codex resumes an
 * active goal after restart, Claude Code restores /goal on resume).
 *
 * Conversations owned by the scheduler / a trigger / an IM channel are left
 * to their own delivery envelope (the scheduler's catch-up re-runs a missed
 * task); read-only imports never run. Returns true when a run was started.
 */
export async function resumeTeamRunAfterRestart(conversationId: string, turnCount: number): Promise<boolean> {
  const conversation = useChatStore.getState().conversations[conversationId];
  if (!conversation?.teamId || conversation.readOnly) return false;
  if (conversation.scheduledTaskId || conversation.triggerId || conversation.imChannelId) return false;
  const lastUser = [...conversation.messages].reverse().find((m) => m.role === 'user' && !m.isSystem);
  if (!lastUser) return false;
  const request = getMessageText(lastUser.content).trim().slice(0, MAX_REQUEST_CHARS);
  if (!request) return false;
  try {
    await runAgentLoopDispatched(conversationId, format(getI18n().team.resumeAfterRestart, { turn: turnCount, request }));
    return true;
  } catch {
    return false;
  }
}
