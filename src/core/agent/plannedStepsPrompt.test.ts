import { describe, it, expect, beforeEach } from 'vitest';
import { useTaskExecutionStore } from '../../stores/taskExecutionStore';
import { formatPlannedStepsForPrompt } from './plannedStepsPrompt';

describe('formatPlannedStepsForPrompt', () => {
  beforeEach(() => {
    useTaskExecutionStore.setState({ executions: {}, activeExecutionId: null, loopIdIndex: {} });
  });

  it('returns empty string when there is no execution', () => {
    expect(formatPlannedStepsForPrompt('nope')).toBe('');
  });

  it('formats steps with emoji and completed count', () => {
    const store = useTaskExecutionStore.getState();
    const exec = store.createExecution('conv-1', 'loop-1');
    store.setPlannedSteps(exec.id, [
      { index: 1, description: 'Scan', status: 'completed' },
      { index: 2, description: 'Build', status: 'in_progress' },
    ]);
    const out = formatPlannedStepsForPrompt('conv-1');
    expect(out).toContain('1/2');
    expect(out).toContain('✅');
    expect(out).toContain('🔄');
    expect(out).toContain('Scan');
  });

  // LLM-facing system prompts must be English (CLAUDE.md language convention);
  // response language is controlled separately by the response-language section.
  it('uses an English header, not Chinese', () => {
    const store = useTaskExecutionStore.getState();
    const exec = store.createExecution('conv-1', 'loop-1');
    store.setPlannedSteps(exec.id, [{ index: 1, description: 'Scan', status: 'completed' }]);
    const out = formatPlannedStepsForPrompt('conv-1');
    expect(out).toContain('Current task plan');
    expect(out).toContain('1/1 completed');
    expect(out).not.toContain('已完成');
  });
});
