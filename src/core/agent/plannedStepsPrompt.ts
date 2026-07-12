import { useTaskExecutionStore } from '../../stores/taskExecutionStore';
import { useChatStore } from '../../stores/chatStore';
import type { PlannedStep } from '../../types/execution';

const STATUS_EMOJI: Record<PlannedStep['status'], string> = {
  pending: '⬜',
  in_progress: '🔄',
  completed: '✅',
};

/** Latest non-empty plannedSteps snapshot persisted on a conversation message.
 * A follow-up turn starts a fresh empty execution, but the prior plan/progress
 * was snapshotted onto messages and should stay visible to the model. */
function latestSnapshotPlannedSteps(conversationId: string): PlannedStep[] {
  const conv = useChatStore.getState().conversations[conversationId];
  if (!conv) return [];
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const ps = conv.messages[i].plannedSteps;
    if (ps && ps.length > 0) return ps;
  }
  return [];
}

/**
 * Format the conversation's current planned steps for per-turn prompt injection.
 * Mirrors the old formatTodosForPrompt output, sourced from the declared plan.
 */
export function formatPlannedStepsForPrompt(conversationId: string): string {
  const exec = useTaskExecutionStore.getState().getExecutionByConversationId(conversationId);
  const steps = exec?.plannedSteps?.length
    ? exec.plannedSteps
    : latestSnapshotPlannedSteps(conversationId);
  if (steps.length === 0) return '';

  const lines = steps.map((s) => `${s.index}. ${STATUS_EMOJI[s.status as PlannedStep['status']] ?? '⬜'} [${s.status}] ${s.description}`);
  const completed = steps.filter((s) => s.status === 'completed').length;
  return `## Current task plan (${completed}/${steps.length} completed)\n${lines.join('\n')}`;
}
