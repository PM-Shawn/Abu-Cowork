import { describe, it, expect, beforeEach } from 'vitest';
import { useTaskExecutionStore } from './taskExecutionStore';

describe('taskExecutionStore', () => {
  beforeEach(() => {
    useTaskExecutionStore.setState({
      executions: {},
      activeExecutionId: null,
      loopIdIndex: {},
    });
  });

  // ── completeExecution auto-completes remaining planned steps ──
  describe('completeExecution planned step cleanup', () => {
    it('marks remaining pending/in_progress planned steps as completed when execution completes', () => {
      const store = useTaskExecutionStore.getState();
      const exec = store.createExecution('conv-1', 'loop-1');

      store.setPlannedSteps(exec.id, [
        { index: 1, description: '步骤1', status: 'completed' },
        { index: 2, description: '步骤2', status: 'in_progress' },
        { index: 3, description: '步骤3', status: 'pending' },
      ]);

      store.completeExecution(exec.id);

      const final = useTaskExecutionStore.getState().executions[exec.id];
      expect(final.plannedSteps[0].status).toBe('completed');
      expect(final.plannedSteps[1].status).toBe('completed');
      expect(final.plannedSteps[2].status).toBe('completed');
      expect(final.status).toBe('completed');
    });
  });

  // ── cancelExecution reverts an in-progress step so the panel stops spinning ──
  describe('cancelExecution planned step cleanup', () => {
    it('reverts in_progress planned steps to pending on cancel (no perpetual spinner)', () => {
      const store = useTaskExecutionStore.getState();
      const exec = store.createExecution('conv-1', 'loop-1');

      store.setPlannedSteps(exec.id, [
        { index: 1, description: '步骤1', status: 'in_progress' },
        { index: 2, description: '步骤2', status: 'pending' },
      ]);

      store.cancelExecution(exec.id);

      const final = useTaskExecutionStore.getState().executions[exec.id];
      expect(final.status).toBe('cancelled');
      expect(final.plannedSteps[0].status).toBe('pending');
      expect(final.plannedSteps[1].status).toBe('pending');
    });
  });

  describe('getExecutionByConversationId', () => {
    it('returns the latest execution for a conversation', () => {
      const store = useTaskExecutionStore.getState();
      store.createExecution('conv-1', 'loop-1');
      const e2 = store.createExecution('conv-1', 'loop-2');
      const found = useTaskExecutionStore.getState().getExecutionByConversationId('conv-1');
      expect(found?.id).toBe(e2.id);
    });

    it('returns undefined when no execution matches', () => {
      expect(useTaskExecutionStore.getState().getExecutionByConversationId('nope')).toBeUndefined();
    });
  });
});
