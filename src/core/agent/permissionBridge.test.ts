/**
 * Tests for the UserQuestion queue in permissionBridge.ts
 *
 * Covers only the new requestUserQuestion / resolveUserQuestion /
 * drainUserQuestions / drainUserQuestionsForConversation /
 * subscribeUserQuestion / getPendingUserQuestions APIs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  requestUserQuestion,
  resolveUserQuestion,
  drainUserQuestions,
  drainUserQuestionsForConversation,
  getPendingUserQuestions,
  subscribeUserQuestion,
} from './permissionBridge';
import type { UserQuestionPayload, UserQuestionResult } from '../../types';

const MINIMAL_PAYLOAD: UserQuestionPayload = {
  questions: [
    {
      header: '格式',
      question: '你希望输出什么格式？',
      multiSelect: false,
      options: [{ label: '详细' }, { label: '简洁' }],
    },
  ],
};

const MINIMAL_RESULT: UserQuestionResult = {
  answers: [{ header: '格式', question: '你希望输出什么格式？', selected: ['详细'] }],
};

describe('permissionBridge — UserQuestion queue', () => {
  beforeEach(() => {
    drainUserQuestions();
  });

  afterEach(() => {
    drainUserQuestions();
  });

  describe('requestUserQuestion + resolveUserQuestion', () => {
    it('suspends a promise that resolveUserQuestion fulfills', async () => {
      const promise = requestUserQuestion('tc-1', 'conv-a', MINIMAL_PAYLOAD);
      expect(getPendingUserQuestions()).toHaveLength(1);
      expect(getPendingUserQuestions()[0].id).toBe('tc-1');

      resolveUserQuestion('tc-1', MINIMAL_RESULT);

      const result = await promise;
      expect(result).toEqual(MINIMAL_RESULT);
      expect(getPendingUserQuestions()).toHaveLength(0);
    });

    it('does not throw when resolving a nonexistent id', () => {
      expect(() => resolveUserQuestion('nonexistent', null)).not.toThrow();
    });

    it('resolves to null when resolved with null', async () => {
      const promise = requestUserQuestion('tc-2', 'conv-b', MINIMAL_PAYLOAD);
      resolveUserQuestion('tc-2', null);
      const result = await promise;
      expect(result).toBeNull();
    });
  });

  describe('drainUserQuestions', () => {
    it('resolves all pending to null and clears the queue', async () => {
      const p1 = requestUserQuestion('tc-3', 'conv-c', MINIMAL_PAYLOAD);
      const p2 = requestUserQuestion('tc-4', 'conv-c', MINIMAL_PAYLOAD);
      drainUserQuestions();
      expect(getPendingUserQuestions()).toHaveLength(0);
      expect(await p1).toBeNull();
      expect(await p2).toBeNull();
    });
  });

  describe('drainUserQuestionsForConversation', () => {
    it('only drains pending for the given conversationId', async () => {
      const pA = requestUserQuestion('tc-5', 'conv-target', MINIMAL_PAYLOAD);
      const pB = requestUserQuestion('tc-6', 'conv-other', MINIMAL_PAYLOAD);

      drainUserQuestionsForConversation('conv-target');

      expect(await pA).toBeNull();
      // pB should still be pending
      expect(getPendingUserQuestions()).toHaveLength(1);
      expect(getPendingUserQuestions()[0].id).toBe('tc-6');

      // cleanup
      resolveUserQuestion('tc-6', null);
      await pB;
    });
  });

  describe('subscribeUserQuestion', () => {
    it('fires on both enqueue and dequeue, stops after unsubscribe', () => {
      const listener = vi.fn();
      const unsub = subscribeUserQuestion(listener);

      requestUserQuestion('tc-7', 'conv-d', MINIMAL_PAYLOAD);
      expect(listener).toHaveBeenCalledTimes(1);

      resolveUserQuestion('tc-7', null);
      expect(listener).toHaveBeenCalledTimes(2);

      unsub();
      requestUserQuestion('tc-8', 'conv-d', MINIMAL_PAYLOAD);
      expect(listener).toHaveBeenCalledTimes(2);
      drainUserQuestions();
    });
  });

  describe('timeout', () => {
    it('auto-resolves to null after USER_QUESTION_TIMEOUT_MS', async () => {
      vi.useFakeTimers();
      const promise = requestUserQuestion('tc-timeout', 'conv-e', MINIMAL_PAYLOAD);
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 100);
      const result = await promise;
      expect(result).toBeNull();
      vi.useRealTimers();
    });
  });
});
