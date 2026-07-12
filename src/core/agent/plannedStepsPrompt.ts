import { useTaskExecutionStore } from '../../stores/taskExecutionStore';
import type { PlannedStep } from '../../types/execution';

const STATUS_EMOJI: Record<PlannedStep['status'], string> = {
  pending: '⬜',
  in_progress: '🔄',
  completed: '✅',
};

/**
 * Format the conversation's current planned steps for per-turn prompt injection.
 * Mirrors the old formatTodosForPrompt output, sourced from the declared plan.
 */
export function formatPlannedStepsForPrompt(conversationId: string): string {
  const exec = useTaskExecutionStore.getState().getExecutionByConversationId(conversationId);
  const steps = exec?.plannedSteps ?? [];
  if (steps.length === 0) return '';

  const lines = steps.map((s) => `${s.index}. ${STATUS_EMOJI[s.status]} [${s.status}] ${s.description}`);
  const completed = steps.filter((s) => s.status === 'completed').length;
  return `## 当前任务计划 (${completed}/${steps.length} 已完成)\n${lines.join('\n')}`;
}
