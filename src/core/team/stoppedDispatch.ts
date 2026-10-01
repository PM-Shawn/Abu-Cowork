import { useTeamConfirmationStore } from '@/stores/teamConfirmationStore';
import { getRunBounds, type DispatchRefusal } from './teamRunBounds';

/**
 * Put a hand-off the task's bounds refused on the confirmation strip, where
 * the user chooses to try another way or skip the step. The leader still
 * gets the refusal as its tool result; this is what the user sees. Outside
 * a team task there is no strip to show it on.
 */
export function surfaceStoppedDispatch(
  context: { conversationId?: string; teamTaskId?: string } | undefined,
  refusal: DispatchRefusal,
): void {
  if (!context?.conversationId || !context.teamTaskId) return;
  if (refusal.reason === 'member_blocked') {
    const lastFailure = getRunBounds(context.teamTaskId).lastFailure[refusal.member];
    useTeamConfirmationStore.getState().addStopped({
      conversationId: context.conversationId,
      taskId: context.teamTaskId,
      reason: 'member_blocked',
      member: refusal.member,
      count: refusal.failures,
      ...(lastFailure ? { lastFailure } : {}),
    });
    return;
  }
  useTeamConfirmationStore.getState().addStopped({
    conversationId: context.conversationId,
    taskId: context.teamTaskId,
    reason: 'run_cap',
    count: refusal.used,
  });
}
