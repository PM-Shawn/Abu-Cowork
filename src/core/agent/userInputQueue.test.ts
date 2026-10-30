/**
 * Queue staging semantics: user follow-ups live outside the transcript in a
 * cancellable staging area until the current task finishes; system wake-ups
 * may be consumed inside the current loop.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ImageEditRequest } from '@/types/media';
import {
  enqueueUserInput,
  enqueueUserInputWithId,
  dequeueNextUserInput,
  drainQueuedInputs,
  drainSystemQueuedInputs,
  clearInputQueue,
  getQueuedInputs,
  hasSystemQueuedInputs,
  isUserInputQueuePaused,
  pauseUserInputQueue,
  removeQueuedInput,
  restoreDequeuedUserInput,
  resumeUserInputQueue,
  subscribeToInputQueue,
} from './userInputQueue';

const CONV = 'conv-queue-test';

describe('userInputQueue staging', () => {
  beforeEach(() => clearInputQueue(CONV));

  it('queues written comments with the captured image and isolates them from subsequent draft changes', () => {
    const request: ImageEditRequest = {
      schemaVersion: 1, id: 'request-1', messageId: 'message-1', scope: 'local', conversationId: CONV,
      sourceArtifactId: 'source-1', sourceCaptureId: 'capture-1', sourceDigest: 'a'.repeat(64), prompt: '',
      comments: [{ id: 'comment-1', point: { x: 0.5, y: 0.5 }, text: 'Keep the package' }], markup: [], region: [],
      attachmentRefs: [{ kind: 'source', fileRef: { originalPath: '/source.png', captureId: 'capture-1', contentDigest: 'a'.repeat(64) }, mimeType: 'image/png', width: 100, height: 100, byteLength: 100 }],
      backendId: 'images', capabilityVersion: '1',
    };
    enqueueUserInput(CONV, '', false, undefined, undefined, request);
    request.comments[0].text = 'Next edit';
    const queued = dequeueNextUserInput(CONV)!;
    expect(queued.text).toBe('Keep the package');
    expect(queued.imageEditRequest?.comments[0].text).toBe('Keep the package');
    expect(queued.imageEditRequest?.attachmentRefs[0].fileRef.captureId).toBe('capture-1');
    restoreDequeuedUserInput(CONV, queued);
    resumeUserInputQueue(CONV);
    expect(dequeueNextUserInput(CONV)?.imageEditRequest).toEqual(queued.imageEditRequest);
  });

  it('getQueuedInputs exposes queued items for rendering', () => {
    enqueueUserInput(CONV, '数完说你好');
    enqueueUserInput(CONV, '再说声晚安');
    const items = getQueuedInputs(CONV);
    expect(items.map((i) => i.text)).toEqual(['数完说你好', '再说声晚安']);
  });

  it('returns a stable empty array for conversations with no queue', () => {
    expect(getQueuedInputs(CONV)).toBe(getQueuedInputs(CONV));
    expect(getQueuedInputs(CONV)).toHaveLength(0);
  });

  it('returns a stable reference between mutations (useSyncExternalStore contract)', () => {
    enqueueUserInput(CONV, 'a');
    const snap1 = getQueuedInputs(CONV);
    expect(getQueuedInputs(CONV)).toBe(snap1);
    enqueueUserInput(CONV, 'b');
    expect(getQueuedInputs(CONV)).not.toBe(snap1);
  });

  it('removeQueuedInput cancels a single staged item', () => {
    enqueueUserInput(CONV, 'keep');
    enqueueUserInput(CONV, 'cancel me');
    const target = getQueuedInputs(CONV).find((i) => i.text === 'cancel me')!;
    removeQueuedInput(CONV, target.id);
    expect(getQueuedInputs(CONV).map((i) => i.text)).toEqual(['keep']);
    expect(drainQueuedInputs(CONV).map((i) => i.text)).toEqual(['keep']);
  });

  it('drains only system wake-ups while preserving user follow-ups in FIFO order', () => {
    enqueueUserInputWithId(CONV, 'user-1', 'first user');
    enqueueUserInputWithId(CONV, 'system-1', 'background result', true);
    enqueueUserInputWithId(CONV, 'user-2', 'second user');

    expect(hasSystemQueuedInputs(CONV)).toBe(true);
    expect(drainSystemQueuedInputs(CONV).map((item) => item.id)).toEqual(['system-1']);
    expect(hasSystemQueuedInputs(CONV)).toBe(false);
    expect(getQueuedInputs(CONV).map((item) => item.id)).toEqual(['user-1', 'user-2']);
  });

  it('dequeues user follow-ups one at a time without consuming system entries', () => {
    enqueueUserInputWithId(CONV, 'system-1', 'background result', true);
    enqueueUserInputWithId(CONV, 'user-1', 'first user');
    enqueueUserInputWithId(CONV, 'user-2', 'second user');

    expect(dequeueNextUserInput(CONV)?.id).toBe('user-1');
    expect(getQueuedInputs(CONV).map((item) => item.id)).toEqual(['system-1', 'user-2']);
    expect(dequeueNextUserInput(CONV)?.id).toBe('user-2');
    expect(dequeueNextUserInput(CONV)).toBeUndefined();
    expect(getQueuedInputs(CONV).map((item) => item.id)).toEqual(['system-1']);
  });

  it('blocks FIFO handoff while paused and resumes without losing order', () => {
    enqueueUserInputWithId(CONV, 'user-1', 'first user');
    enqueueUserInputWithId(CONV, 'user-2', 'second user');

    pauseUserInputQueue(CONV);

    expect(isUserInputQueuePaused(CONV)).toBe(true);
    expect(dequeueNextUserInput(CONV)).toBeUndefined();
    expect(getQueuedInputs(CONV).map((item) => item.id)).toEqual(['user-1', 'user-2']);

    resumeUserInputQueue(CONV);
    expect(isUserInputQueuePaused(CONV)).toBe(false);
    expect(dequeueNextUserInput(CONV)?.id).toBe('user-1');
    expect(dequeueNextUserInput(CONV)?.id).toBe('user-2');
  });

  it('atomically restores a failed handoff at the front and pauses the queue', () => {
    enqueueUserInputWithId(CONV, 'user-1', 'first user');
    enqueueUserInputWithId(CONV, 'user-2', 'second user');
    const first = dequeueNextUserInput(CONV)!;
    const observedPausedStates: boolean[] = [];
    const unsubscribe = subscribeToInputQueue(() => {
      observedPausedStates.push(isUserInputQueuePaused(CONV));
    });

    restoreDequeuedUserInput(CONV, first);
    unsubscribe();

    expect(getQueuedInputs(CONV).map((item) => item.id)).toEqual(['user-1', 'user-2']);
    expect(getQueuedInputs(CONV)[0]).toEqual(first);
    expect(isUserInputQueuePaused(CONV)).toBe(true);
    expect(observedPausedStates).toEqual([true]);
    expect(dequeueNextUserInput(CONV)).toBeUndefined();

    resumeUserInputQueue(CONV);
    expect(dequeueNextUserInput(CONV)?.id).toBe('user-1');
    expect(dequeueNextUserInput(CONV)?.id).toBe('user-2');
  });

  it('deduplicates a repeated restore of the same dequeued item', () => {
    enqueueUserInputWithId(CONV, 'user-1', 'first user');
    enqueueUserInputWithId(CONV, 'user-2', 'second user');
    const first = dequeueNextUserInput(CONV)!;

    restoreDequeuedUserInput(CONV, first);
    restoreDequeuedUserInput(CONV, first);

    expect(getQueuedInputs(CONV).map((item) => item.id)).toEqual(['user-1', 'user-2']);
    expect(getQueuedInputs(CONV).filter((item) => item.id === 'user-1')).toHaveLength(1);
  });

  it('keeps an enqueued message accepted when one subscriber throws', () => {
    const healthySubscriber = vi.fn();
    const unsubscribeThrowing = subscribeToInputQueue(() => {
      throw new Error('broken queue observer');
    });
    const unsubscribeHealthy = subscribeToInputQueue(healthySubscriber);

    try {
      expect(() => enqueueUserInput(CONV, 'accepted follow-up')).not.toThrow();
      expect(getQueuedInputs(CONV).map((item) => item.text)).toEqual(['accepted follow-up']);
      expect(healthySubscriber).toHaveBeenCalledOnce();
    } finally {
      unsubscribeThrowing();
      unsubscribeHealthy();
    }
  });

  it('returns a dequeued message even when one subscriber throws', () => {
    enqueueUserInputWithId(CONV, 'user-1', 'first user');
    enqueueUserInputWithId(CONV, 'user-2', 'second user');
    const healthySubscriber = vi.fn();
    const unsubscribeThrowing = subscribeToInputQueue(() => {
      throw new Error('broken queue observer');
    });
    const unsubscribeHealthy = subscribeToInputQueue(healthySubscriber);

    try {
      expect(dequeueNextUserInput(CONV)?.id).toBe('user-1');
      expect(getQueuedInputs(CONV).map((item) => item.id)).toEqual(['user-2']);
      expect(healthySubscriber).toHaveBeenCalledOnce();
    } finally {
      unsubscribeThrowing();
      unsubscribeHealthy();
    }
  });

  it('finishes restoring and pausing a handoff when one subscriber throws', () => {
    enqueueUserInputWithId(CONV, 'user-1', 'first user');
    enqueueUserInputWithId(CONV, 'user-2', 'second user');
    const first = dequeueNextUserInput(CONV)!;
    const healthySubscriber = vi.fn();
    const unsubscribeThrowing = subscribeToInputQueue(() => {
      throw new Error('broken queue observer');
    });
    const unsubscribeHealthy = subscribeToInputQueue(healthySubscriber);

    try {
      expect(() => restoreDequeuedUserInput(CONV, first)).not.toThrow();
      expect(getQueuedInputs(CONV).map((item) => item.id)).toEqual(['user-1', 'user-2']);
      expect(isUserInputQueuePaused(CONV)).toBe(true);
      expect(healthySubscriber).toHaveBeenCalledOnce();
    } finally {
      unsubscribeThrowing();
      unsubscribeHealthy();
    }
  });

  it('clears the paused state after the last user item is cancelled', () => {
    enqueueUserInputWithId(CONV, 'user-1', 'only user');
    pauseUserInputQueue(CONV);

    removeQueuedInput(CONV, 'user-1');

    expect(isUserInputQueuePaused(CONV)).toBe(false);
  });

  describe('enqueueUserInputWithId (P1-3B-4)', () => {
    it('preserves the caller-supplied id instead of generating one', () => {
      enqueueUserInputWithId(CONV, 'caller-id-1', 'hello');
      const items = getQueuedInputs(CONV);
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('caller-id-1');
      expect(items[0].text).toBe('hello');
    });

    it('appends after existing entries, preserving insertion order (mixed with enqueueUserInput)', () => {
      enqueueUserInput(CONV, 'first');
      enqueueUserInputWithId(CONV, 'caller-id-2', 'second');
      enqueueUserInput(CONV, 'third');
      const items = getQueuedInputs(CONV);
      expect(items.map((i) => i.text)).toEqual(['first', 'second', 'third']);
      expect(items[1].id).toBe('caller-id-2');
    });

    it('threads the isSystem flag through', () => {
      enqueueUserInputWithId(CONV, 'sys-1', 'background result', true);
      expect(getQueuedInputs(CONV)[0].isSystem).toBe(true);
    });

    it('drops an empty/whitespace-only message, same guard as enqueueUserInput', () => {
      enqueueUserInputWithId(CONV, 'caller-id-3', '   ');
      expect(getQueuedInputs(CONV)).toHaveLength(0);
    });

    it('is drained by drainQueuedInputs like any other entry, id intact', () => {
      enqueueUserInputWithId(CONV, 'caller-id-4', 'drain me');
      const drained = drainQueuedInputs(CONV);
      expect(drained.map((i) => ({ id: i.id, text: i.text }))).toEqual([{ id: 'caller-id-4', text: 'drain me' }]);
      expect(getQueuedInputs(CONV)).toHaveLength(0);
    });
  });
});
