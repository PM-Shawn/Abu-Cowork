import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useBatchProgressStore } from './batchProgressStore';

describe('batchProgressStore', () => {
  beforeEach(() => {
    useBatchProgressStore.setState({ batches: {} });
  });

  describe('initBatch', () => {
    it('seeds tasks as queued with correct labels', () => {
      useBatchProgressStore.getState().initBatch('tc-1', ['Task A', 'Task B']);
      const batch = useBatchProgressStore.getState().batches['tc-1'];
      expect(batch).toBeDefined();
      expect(batch.tasks).toHaveLength(2);
      expect(batch.tasks[0]).toEqual({ label: 'Task A', status: 'queued' });
      expect(batch.tasks[1]).toEqual({ label: 'Task B', status: 'queued' });
    });

    it('records startedAt close to now', () => {
      // Deterministic: freeze the clock instead of bracketing a real
      // Date.now() read with before/after real-time bounds (TESTING.md §3).
      const fixedNow = 1_700_000_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(fixedNow);
      try {
        useBatchProgressStore.getState().initBatch('tc-2', ['X']);
        const batch = useBatchProgressStore.getState().batches['tc-2'];
        expect(batch.startedAt).toBe(fixedNow);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('setTaskRunning', () => {
    it('marks the task as running', () => {
      useBatchProgressStore.getState().initBatch('tc-3', ['Task A', 'Task B']);
      useBatchProgressStore.getState().setTaskRunning('tc-3', 0);
      expect(useBatchProgressStore.getState().batches['tc-3'].tasks[0].status).toBe('running');
      // Other tasks unaffected
      expect(useBatchProgressStore.getState().batches['tc-3'].tasks[1].status).toBe('queued');
    });

    it('no-ops on unknown toolCallId', () => {
      expect(() => useBatchProgressStore.getState().setTaskRunning('unknown', 0)).not.toThrow();
    });
  });

  describe('setTaskActivity', () => {
    it('updates activity and turn', () => {
      useBatchProgressStore.getState().initBatch('tc-4', ['Task A']);
      useBatchProgressStore.getState().setTaskActivity('tc-4', 0, '调用 web_search', 2);
      const task = useBatchProgressStore.getState().batches['tc-4'].tasks[0];
      expect(task.activity).toBe('调用 web_search');
      expect(task.turn).toBe(2);
    });
  });

  describe('setTaskDone', () => {
    it('marks task done on success', () => {
      useBatchProgressStore.getState().initBatch('tc-5', ['Task A']);
      useBatchProgressStore.getState().setTaskDone('tc-5', 0, false);
      expect(useBatchProgressStore.getState().batches['tc-5'].tasks[0].status).toBe('done');
    });

    it('marks task error on failure', () => {
      useBatchProgressStore.getState().initBatch('tc-6', ['Task A']);
      useBatchProgressStore.getState().setTaskDone('tc-6', 0, true);
      expect(useBatchProgressStore.getState().batches['tc-6'].tasks[0].status).toBe('error');
    });

    it('clears activity on done', () => {
      useBatchProgressStore.getState().initBatch('tc-7', ['Task A']);
      useBatchProgressStore.getState().setTaskActivity('tc-7', 0, '调用工具', 1);
      useBatchProgressStore.getState().setTaskDone('tc-7', 0);
      expect(useBatchProgressStore.getState().batches['tc-7'].tasks[0].activity).toBeUndefined();
    });
  });

  describe('clearBatch', () => {
    it('removes the batch entry', () => {
      useBatchProgressStore.getState().initBatch('tc-8', ['Task A']);
      useBatchProgressStore.getState().clearBatch('tc-8');
      expect(useBatchProgressStore.getState().batches['tc-8']).toBeUndefined();
    });
  });
});
