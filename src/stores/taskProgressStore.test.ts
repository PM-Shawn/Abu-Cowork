import { describe, it, expect, beforeEach } from 'vitest';
import { useTaskProgressStore } from './taskProgressStore';
import type { TaskStep } from './taskProgressStore';

function makeStep(overrides: Partial<TaskStep> = {}): TaskStep {
  return {
    id: 'step-default', // filler (TESTING.md §3) — callers that care override it
    label: 'Test step',
    status: 'pending',
    ...overrides,
  };
}

describe('taskProgressStore', () => {
  beforeEach(() => {
    useTaskProgressStore.getState().clearSteps();
  });

  // ── setSteps ──
  describe('setSteps', () => {
    it('sets steps and conversationId', () => {
      const steps = [makeStep({ id: 's1' }), makeStep({ id: 's2' })];
      useTaskProgressStore.getState().setSteps(steps, 'conv1');
      const state = useTaskProgressStore.getState();
      expect(state.steps).toHaveLength(2);
      expect(state.hasSteps).toBe(true);
      expect(state.conversationId).toBe('conv1');
      expect(state.currentStepId).toBeNull();
    });

    it('replaces existing steps', () => {
      useTaskProgressStore.getState().setSteps([makeStep()], 'conv1');
      useTaskProgressStore.getState().setSteps([makeStep(), makeStep(), makeStep()], 'conv2');
      expect(useTaskProgressStore.getState().steps).toHaveLength(3);
    });
  });

  // ── addStep ──
  describe('addStep', () => {
    it('adds a step', () => {
      useTaskProgressStore.getState().addStep(makeStep({ id: 's1' }));
      expect(useTaskProgressStore.getState().steps).toHaveLength(1);
      expect(useTaskProgressStore.getState().hasSteps).toBe(true);
    });
  });

  // ── startStep ──
  describe('startStep', () => {
    it('marks step as running with startTime', () => {
      const step = makeStep({ id: 's1' });
      useTaskProgressStore.getState().setSteps([step], 'conv1');
      useTaskProgressStore.getState().startStep('s1');
      const state = useTaskProgressStore.getState();
      expect(state.steps[0].status).toBe('running');
      expect(state.steps[0].startTime).toBeDefined();
      expect(state.currentStepId).toBe('s1');
    });
  });

  // ── completeStep ──
  describe('completeStep', () => {
    it('marks step as completed and moves to next pending', () => {
      const steps = [makeStep({ id: 's1' }), makeStep({ id: 's2' })];
      useTaskProgressStore.getState().setSteps(steps, 'conv1');
      useTaskProgressStore.getState().startStep('s1');
      useTaskProgressStore.getState().completeStep('s1', 'Done!');

      const state = useTaskProgressStore.getState();
      expect(state.steps[0].status).toBe('completed');
      expect(state.steps[0].endTime).toBeDefined();
      expect(state.steps[0].completionMessage).toBe('Done!');
      expect(state.currentStepId).toBe('s2'); // moved to next
    });

    it('sets currentStepId to null when all completed', () => {
      useTaskProgressStore.getState().setSteps([makeStep({ id: 's1' })], 'conv1');
      useTaskProgressStore.getState().completeStep('s1');
      expect(useTaskProgressStore.getState().currentStepId).toBeNull();
    });
  });

  // ── errorStep ──
  describe('errorStep', () => {
    it('marks step as error with message', () => {
      useTaskProgressStore.getState().setSteps([makeStep({ id: 's1' })], 'conv1');
      useTaskProgressStore.getState().errorStep('s1', 'Something failed');
      const state = useTaskProgressStore.getState();
      expect(state.steps[0].status).toBe('error');
      expect(state.steps[0].detail).toBe('Something failed');
      expect(state.steps[0].endTime).toBeDefined();
    });
  });

  // ── updateStepProgress ──
  describe('updateStepProgress', () => {
    it('updates progress for batch operations', () => {
      useTaskProgressStore.getState().setSteps([makeStep({ id: 's1' })], 'conv1');
      useTaskProgressStore.getState().updateStepProgress('s1', 3, 10);
      const { progress } = useTaskProgressStore.getState().steps[0];
      expect(progress).toEqual({ current: 3, total: 10 });
    });
  });

  // ── linkToolCall ──
  describe('linkToolCall', () => {
    it('associates tool call ID with step', () => {
      useTaskProgressStore.getState().setSteps([makeStep({ id: 's1' })], 'conv1');
      useTaskProgressStore.getState().linkToolCall('s1', 'tc1');
      useTaskProgressStore.getState().linkToolCall('s1', 'tc2');
      expect(useTaskProgressStore.getState().steps[0].toolCallIds).toEqual(['tc1', 'tc2']);
    });

    it('does not duplicate tool call IDs', () => {
      useTaskProgressStore.getState().setSteps([makeStep({ id: 's1' })], 'conv1');
      useTaskProgressStore.getState().linkToolCall('s1', 'tc1');
      useTaskProgressStore.getState().linkToolCall('s1', 'tc1');
      expect(useTaskProgressStore.getState().steps[0].toolCallIds).toHaveLength(1);
    });
  });

  // ── findStepByToolCallId ──
  describe('findStepByToolCallId', () => {
    it('finds step by associated tool call', () => {
      useTaskProgressStore.getState().setSteps([makeStep({ id: 's1' }), makeStep({ id: 's2' })], 'conv1');
      useTaskProgressStore.getState().linkToolCall('s2', 'tc5');
      const found = useTaskProgressStore.getState().findStepByToolCallId('tc5');
      expect(found?.id).toBe('s2');
    });

    it('returns undefined for unknown tool call', () => {
      expect(useTaskProgressStore.getState().findStepByToolCallId('unknown')).toBeUndefined();
    });
  });

  // ── clearSteps ──
  describe('clearSteps', () => {
    it('resets all state', () => {
      useTaskProgressStore.getState().setSteps([makeStep()], 'conv1');
      useTaskProgressStore.getState().clearSteps();
      const state = useTaskProgressStore.getState();
      expect(state.steps).toHaveLength(0);
      expect(state.hasSteps).toBe(false);
      expect(state.currentStepId).toBeNull();
      expect(state.conversationId).toBeNull();
    });
  });

  // ── updateStep ──
  describe('updateStep', () => {
    it('updates arbitrary step fields', () => {
      useTaskProgressStore.getState().setSteps([makeStep({ id: 's1', label: 'old' })], 'conv1');
      useTaskProgressStore.getState().updateStep('s1', { label: 'new', detail: 'extra' });
      const step = useTaskProgressStore.getState().steps[0];
      expect(step.label).toBe('new');
      expect(step.detail).toBe('extra');
    });
  });
});
