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

  // ── child steps (subagent tool visualization) ──
  describe('updateChildStep detail blocks', () => {
    function setupWithChild() {
      const store = useTaskExecutionStore.getState();
      const exec = store.createExecution('conv-1', 'loop-1');
      store.addStep(exec.id, {
        id: 'parent-1',
        executionId: exec.id,
        type: 'delegate',
        label: 'Delegate',
        status: 'running',
        toolName: 'delegate_to_agent',
        toolInput: {},
        source: 'agent',
        detailBlocks: [],
      });
      store.addChildStep(exec.id, 'parent-1', {
        id: 'child-1',
        executionId: exec.id,
        type: 'tool',
        label: 'Screenshot',
        status: 'running',
        toolName: 'computer',
        toolInput: {},
        source: 'agent',
        detailBlocks: [],
      });
      return exec.id;
    }

    const imageBlock = {
      id: 'child-1-image',
      stepId: 'child-1',
      type: 'image' as const,
      label: 'Image',
      content: 'Image: /tmp/shot.png',
      imageData: { mediaType: 'image/png', base64: 'aGk=' },
      isTruncated: false,
      isExpanded: true,
    };

    it('appends the provided detail blocks to the child step on completion', () => {
      const execId = setupWithChild();
      useTaskExecutionStore.getState().updateChildStep(execId, 'parent-1', 'child-1', 'done', false, [imageBlock]);

      const child = useTaskExecutionStore.getState().executions[execId].steps[0].childSteps![0];
      expect(child.status).toBe('completed');
      expect(child.toolResult).toBe('done');
      expect(child.detailBlocks).toHaveLength(1);
      expect(child.detailBlocks[0].imageData).toEqual({ mediaType: 'image/png', base64: 'aGk=' });
    });

    it('leaves detail blocks untouched when none are provided (pre-existing shape)', () => {
      const execId = setupWithChild();
      useTaskExecutionStore.getState().updateChildStep(execId, 'parent-1', 'child-1', 'done', false);

      const child = useTaskExecutionStore.getState().executions[execId].steps[0].childSteps![0];
      expect(child.detailBlocks).toHaveLength(0);
    });

    it('toggleDetailExpanded reaches a child step\'s detail block', () => {
      const execId = setupWithChild();
      useTaskExecutionStore.getState().updateChildStep(execId, 'parent-1', 'child-1', 'done', false, [imageBlock]);

      useTaskExecutionStore.getState().toggleDetailExpanded(execId, 'child-1', 'child-1-image');

      const child = useTaskExecutionStore.getState().executions[execId].steps[0].childSteps![0];
      expect(child.detailBlocks[0].isExpanded).toBe(false);
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
