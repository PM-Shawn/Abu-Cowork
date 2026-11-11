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
  isSteerableText,
  isSteeringInput,
  restoreSteeringInputs,
  sendQueuedInputAfterRun,
  steeredMessageId,
  takeSteeringInputs,
  takeSteeringInputsNow,
  beginSteeringRun,
  endSteeringRun,
  requeueUserInput,
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

  describe('steering', () => {
    const RUN = 'run-a';
    beforeEach(() => {
      clearInputQueue(CONV);
      beginSteeringRun(CONV, RUN);
    });

    it('stages plain user text as steering of the run, and everything else for after the run', () => {
      const plain = enqueueUserInput(CONV, '  改成蓝色  ');
      const skill = enqueueUserInput(CONV, '/ppt 做一份汇报');
      const expert = enqueueUserInput(CONV, '@财务 看一下');
      const system = enqueueUserInput(CONV, '后台结果', true);
      const retry = enqueueUserInput(CONV, '确认', false, 'approval-1');
      const continuation = enqueueUserInput(CONV, '继续', false, undefined, true);

      expect(plain).toMatchObject({ text: '改成蓝色', delivery: 'steer', runId: RUN });
      for (const item of [skill, expert, system, retry, continuation]) {
        expect(item?.delivery).toBeUndefined();
        expect(item?.runId).toBeUndefined();
      }
      expect(getQueuedInputs(CONV).filter(isSteeringInput).map((item) => item.text)).toEqual(['改成蓝色']);
    });

    it('an image edit request typed while the run reads steering is never steered: it keeps its prepared pictures and starts its own turn', () => {
      const request: ImageEditRequest = {
        schemaVersion: 1, id: 'request-steer', messageId: 'message-steer', scope: 'local', conversationId: CONV,
        sourceArtifactId: 'source-1', sourceCaptureId: 'capture-1', sourceDigest: 'a'.repeat(64), prompt: '',
        comments: [{ id: 'comment-1', point: { x: 0.5, y: 0.5 }, text: 'Make it blue' }], markup: [], region: [],
        attachmentRefs: [{ kind: 'source', fileRef: { originalPath: '/source.png', captureId: 'capture-1', contentDigest: 'a'.repeat(64) }, mimeType: 'image/png', width: 100, height: 100, byteLength: 100 }],
        backendId: 'images', capabilityVersion: '1',
      };
      // Plain words with a request attached are still an image edit, not a correction.
      const withText = enqueueUserInput(CONV, 'Make it blue', false, undefined, undefined, request);
      const withoutText = enqueueUserInput(CONV, '', false, undefined, undefined, request);

      for (const item of [withText, withoutText]) {
        expect(item?.delivery).toBeUndefined();
        expect(item?.runId).toBeUndefined();
        expect(item?.imageEditRequest).toEqual(request);
      }
      expect(takeSteeringInputsNow(CONV, RUN)).toEqual([]);
      // The run that ends hands each one out as its own turn, request included.
      endSteeringRun(CONV, RUN);
      expect(dequeueNextUserInput(CONV)).toMatchObject({ id: withText?.id, imageEditRequest: request });
      expect(dequeueNextUserInput(CONV)).toMatchObject({ id: withoutText?.id, imageEditRequest: request });
    });

    it('a sub-agent result (a system entry) and a steering message never take each other\'s place', () => {
      const steer = enqueueUserInput(CONV, '只要华东区的');
      enqueueUserInput(CONV, '后台代理的结果', true);

      // The loop's own wake-up drain leaves the user's message for its step boundary.
      expect(drainSystemQueuedInputs(CONV).map((item) => item.text)).toEqual(['后台代理的结果']);
      expect(getQueuedInputs(CONV).map((item) => item.id)).toEqual([steer?.id]);

      enqueueUserInput(CONV, '另一个后台结果', true);
      // The step-boundary take leaves the wake-up for the drain.
      expect(takeSteeringInputsNow(CONV, RUN).map((item) => item.id)).toEqual([steer?.id]);
      expect(hasSystemQueuedInputs(CONV)).toBe(true);
    });

    it('the loop of a sub-agent the run started has its own id and takes nothing of the lead\'s messages', () => {
      enqueueUserInput(CONV, '只要华东区的');
      expect(takeSteeringInputsNow(CONV, 'run-a:sub-1')).toEqual([]);
      expect(getQueuedInputs(CONV).filter(isSteeringInput)).toHaveLength(1);
      expect(takeSteeringInputsNow(CONV, RUN)).toHaveLength(1);
    });

    it('stages plain text for after the run when no run reads steering (scheduled, triggered, IM, between runs)', () => {
      endSteeringRun(CONV, RUN);
      const item = enqueueUserInput(CONV, '改成蓝色');
      expect(item?.delivery).toBeUndefined();
      expect(item?.runId).toBeUndefined();
      expect(takeSteeringInputsNow(CONV, RUN)).toEqual([]);
      expect(dequeueNextUserInput(CONV)?.id).toBe(item?.id);
    });

    it('returns nothing for empty text and stages nothing', () => {
      expect(enqueueUserInput(CONV, '   ')).toBeUndefined();
      expect(getQueuedInputs(CONV)).toHaveLength(0);
    });

    it('isSteerableText: route prefixes and blank text do not steer', () => {
      expect(isSteerableText('把标题改短')).toBe(true);
      expect(isSteerableText('  /skill x')).toBe(false);
      expect(isSteerableText('@expert x')).toBe(false);
      expect(isSteerableText(' \n ')).toBe(false);
      expect(isSteerableText('email me at a@b.c')).toBe(true);
    });

    it('takes every steering entry of the run oldest first and leaves the others in order', () => {
      enqueueUserInputWithId(CONV, 'after-1', 'later one');
      const first = enqueueUserInput(CONV, 'first steer')!;
      enqueueUserInputWithId(CONV, 'system-1', 'background', true);
      const second = enqueueUserInput(CONV, 'second steer')!;

      expect(takeSteeringInputsNow(CONV, RUN).map((item) => item.id)).toEqual([first.id, second.id]);
      expect(getQueuedInputs(CONV).map((item) => item.id)).toEqual(['after-1', 'system-1']);
    });

    it('hands each entry out once: a second take finds nothing', () => {
      enqueueUserInput(CONV, 'once');
      expect(takeSteeringInputsNow(CONV, RUN)).toHaveLength(1);
      expect(takeSteeringInputsNow(CONV, RUN)).toEqual([]);
    });

    it('hands another run nothing', () => {
      const item = enqueueUserInput(CONV, 'for run a')!;
      expect(takeSteeringInputsNow(CONV, 'run-b')).toEqual([]);
      expect(takeSteeringInputsNow('conv-other', RUN)).toEqual([]);
      expect(getQueuedInputs(CONV).map((entry) => entry.id)).toEqual([item.id]);
    });

    it('the async take used by the loop takes the same entries', async () => {
      enqueueUserInput(CONV, 'a');
      enqueueUserInput(CONV, 'b');
      expect((await takeSteeringInputs(CONV, RUN)).map((item) => item.text)).toEqual(['a', 'b']);
      expect(getQueuedInputs(CONV)).toHaveLength(0);
    });

    it('the after-run pause does not hold back what was typed into the run', () => {
      enqueueUserInputWithId(CONV, 'after-1', 'waits for resume');
      pauseUserInputQueue(CONV);
      const typed = enqueueUserInput(CONV, 'typed into the run')!;

      expect(takeSteeringInputsNow(CONV, RUN).map((item) => item.id)).toEqual([typed.id]);
      expect(getQueuedInputs(CONV).map((item) => item.id)).toEqual(['after-1']);
      expect(isUserInputQueuePaused(CONV)).toBe(true);
    });

    it('a cancelled entry is never taken', () => {
      const item = enqueueUserInput(CONV, 'cancel me')!;
      removeQueuedInput(CONV, item.id);
      expect(takeSteeringInputsNow(CONV, RUN)).toEqual([]);
    });

    it('"send after the task" makes an entry wait for the end of the run', () => {
      const item = enqueueUserInput(CONV, 'later please')!;
      const snapshot = getQueuedInputs(CONV);

      sendQueuedInputAfterRun(CONV, item.id);

      expect(getQueuedInputs(CONV)).not.toBe(snapshot);
      expect(getQueuedInputs(CONV)[0]).toEqual({ id: item.id, text: 'later please', timestamp: item.timestamp, isSystem: undefined });
      expect(takeSteeringInputsNow(CONV, RUN)).toEqual([]);
      expect(dequeueNextUserInput(CONV)?.id).toBe(item.id);
    });

    it('"send after the task" after the take is a no-op', () => {
      const item = enqueueUserInput(CONV, 'taken')!;
      takeSteeringInputsNow(CONV, RUN);
      const listener = vi.fn();
      const unsubscribe = subscribeToInputQueue(listener);
      sendQueuedInputAfterRun(CONV, item.id);
      unsubscribe();
      expect(listener).not.toHaveBeenCalled();
      expect(getQueuedInputs(CONV)).toHaveLength(0);
    });

    it('the hand-off after a run never starts an entry its live run still takes', () => {
      enqueueUserInputWithId(CONV, 'after-1', 'queued for after');
      const typed = enqueueUserInput(CONV, 'typed into the live run')!;

      expect(dequeueNextUserInput(CONV)?.id).toBe('after-1');
      expect(dequeueNextUserInput(CONV)).toBeUndefined();
      expect(getQueuedInputs(CONV).map((item) => item.id)).toEqual([typed.id]);
    });

    it('the end of the run turns what it never took into entries for after the run, and tells the strip once', () => {
      enqueueUserInput(CONV, 'steer 1');
      enqueueUserInput(CONV, 'steer 2');
      const listener = vi.fn();
      const unsubscribe = subscribeToInputQueue(listener);

      endSteeringRun(CONV, RUN);
      endSteeringRun(CONV, RUN); // idempotent: nothing left to change
      unsubscribe();

      expect(listener).toHaveBeenCalledOnce();
      expect(getQueuedInputs(CONV).map((item) => [item.text, item.delivery, item.runId])).toEqual([
        ['steer 1', undefined, undefined],
        ['steer 2', undefined, undefined],
      ]);
      expect(takeSteeringInputsNow(CONV, RUN)).toEqual([]);
      // They start their own turns, one at a time.
      expect(dequeueNextUserInput(CONV)?.text).toBe('steer 1');
    });

    it('a new run of the conversation never inherits the steering entries of the one before', () => {
      const forA = enqueueUserInput(CONV, 'typed into run a')!;
      beginSteeringRun(CONV, 'run-b'); // run a is over
      const forB = enqueueUserInput(CONV, 'typed into run b')!;

      expect(takeSteeringInputsNow(CONV, 'run-b').map((item) => item.id)).toEqual([forB.id]);
      expect(getQueuedInputs(CONV).map((item) => [item.id, item.delivery])).toEqual([[forA.id, undefined]]);
      // The late end of run a leaves run b reading steering.
      endSteeringRun(CONV, RUN);
      expect(enqueueUserInput(CONV, 'still for run b')?.runId).toBe('run-b');
    });

    it('pausing changes no entry: steering of the live run stays steering', () => {
      enqueueUserInputWithId(CONV, 'after-1', 'queued');
      const typed = enqueueUserInput(CONV, 'typed into the run')!;
      const listener = vi.fn();
      const unsubscribe = subscribeToInputQueue(listener);

      pauseUserInputQueue(CONV);
      pauseUserInputQueue(CONV); // already paused
      unsubscribe();

      expect(listener).toHaveBeenCalledOnce();
      expect(isUserInputQueuePaused(CONV)).toBe(true);
      expect(getQueuedInputs(CONV).map((item) => [item.id, item.delivery])).toEqual([['after-1', undefined], [typed.id, 'steer']]);
    });

    it('restoreSteeringInputs puts taken entries back at the front, oldest first, once', () => {
      enqueueUserInput(CONV, 'a');
      enqueueUserInput(CONV, 'b');
      const taken = takeSteeringInputsNow(CONV, RUN);
      enqueueUserInputWithId(CONV, 'later', 'typed after the take');

      restoreSteeringInputs(CONV, taken);
      restoreSteeringInputs(CONV, taken);

      expect(getQueuedInputs(CONV).map((item) => item.text)).toEqual(['a', 'b', 'typed after the take']);
      expect(takeSteeringInputsNow(CONV, RUN).map((item) => item.text)).toEqual(['a', 'b']);
    });

    it('restoreSteeringInputs after the run ended brings the entries back for after the run', () => {
      enqueueUserInput(CONV, 'a');
      const taken = takeSteeringInputsNow(CONV, RUN);
      endSteeringRun(CONV, RUN);

      restoreSteeringInputs(CONV, taken);

      expect(getQueuedInputs(CONV).map((item) => [item.text, item.delivery, item.runId])).toEqual([['a', undefined, undefined]]);
    });

    it('restoreSteeringInputs with nothing to restore notifies nobody', () => {
      const listener = vi.fn();
      const unsubscribe = subscribeToInputQueue(listener);
      restoreSteeringInputs(CONV, []);
      unsubscribe();
      expect(listener).not.toHaveBeenCalled();
    });

    it('a failed handoff restores its item for after the run and leaves the live run its own entries', () => {
      enqueueUserInputWithId(CONV, 'after-1', 'first');
      const typed = enqueueUserInput(CONV, 'typed into the run')!;
      const first = dequeueNextUserInput(CONV)!;

      restoreDequeuedUserInput(CONV, first);

      expect(getQueuedInputs(CONV).map((item) => [item.text, item.delivery])).toEqual([
        ['first', undefined],
        ['typed into the run', 'steer'],
      ]);
      expect(takeSteeringInputsNow(CONV, RUN).map((item) => item.id)).toEqual([typed.id]);
    });

    it('a hand-off that met a live run goes back at the front under its id, for after the run, and the queue stays resumed', () => {
      enqueueUserInputWithId(CONV, 'after-2', 'next in line');
      const item = { id: 'qi-old', text: 'typed into the run before', timestamp: 3, delivery: 'steer' as const, runId: 'run-old' };
      const listener = vi.fn();
      const unsubscribe = subscribeToInputQueue(listener);

      requeueUserInput(CONV, item);
      requeueUserInput(CONV, item); // a second hand-off of the same entry adds no copy
      unsubscribe();

      expect(listener).toHaveBeenCalledTimes(2);
      expect(getQueuedInputs(CONV).map((qi) => [qi.id, qi.delivery, qi.runId])).toEqual([
        ['qi-old', undefined, undefined],
        ['after-2', undefined, undefined],
      ]);
      expect(isUserInputQueuePaused(CONV)).toBe(false);
      // The live run is not handed it; the hand-off after that run starts it.
      expect(takeSteeringInputsNow(CONV, RUN)).toEqual([]);
      expect(dequeueNextUserInput(CONV)?.id).toBe('qi-old');
    });

    it('a deleted conversation reads no steering any more', () => {
      enqueueUserInput(CONV, 'gone with it');
      clearInputQueue(CONV);
      expect(enqueueUserInput(CONV, 'typed after')?.delivery).toBeUndefined();
    });

    it('names the message a steered entry becomes after the entry', () => {
      expect(steeredMessageId('qi-1')).toBe('steer-qi-1');
    });
  });
});


// Tester additions (P7 steering): races at the take, ordering, and the pause.
describe('userInputQueue steering — tester cases', () => {
  beforeEach(() => {
    clearInputQueue(CONV);
    beginSteeringRun(CONV, 'run-1');
  });

  it('two messages typed during one tool step are handed out together, in the order typed', () => {
    const first = enqueueUserInput(CONV, '只要华东区')!;
    const second = enqueueUserInput(CONV, '按月排序')!;

    const taken = takeSteeringInputsNow(CONV, 'run-1');

    expect(taken.map((item) => [item.id, item.text])).toEqual([[first.id, '只要华东区'], [second.id, '按月排序']]);
    expect(getQueuedInputs(CONV)).toEqual([]);
  });

  it('a message typed while a take is in flight is handed out exactly once, by the next take', () => {
    const early = enqueueUserInput(CONV, 'early')!;
    const firstTake = takeSteeringInputsNow(CONV, 'run-1');
    // Typed after the shell answered the take, before the run added the message.
    const late = enqueueUserInput(CONV, 'late')!;

    const secondTake = takeSteeringInputsNow(CONV, 'run-1');
    const thirdTake = takeSteeringInputsNow(CONV, 'run-1');

    expect(firstTake.map((item) => item.id)).toEqual([early.id]);
    expect(secondTake.map((item) => item.id)).toEqual([late.id]);
    expect(thirdTake).toEqual([]);
  });

  it('a take that was restored and taken again hands each entry out once and keeps the order', () => {
    const a = enqueueUserInput(CONV, 'a')!;
    const taken = takeSteeringInputsNow(CONV, 'run-1');
    const b = enqueueUserInput(CONV, 'b')!;
    restoreSteeringInputs(CONV, taken);
    restoreSteeringInputs(CONV, taken); // a second settle path restores nothing twice

    expect(takeSteeringInputsNow(CONV, 'run-1').map((item) => item.id)).toEqual([a.id, b.id]);
    expect(takeSteeringInputsNow(CONV, 'run-1')).toEqual([]);
  });

  it('the chip\'s "send after the task" and the take never both win', () => {
    const item = enqueueUserInput(CONV, '改一下')!;
    sendQueuedInputAfterRun(CONV, item.id);
    expect(takeSteeringInputsNow(CONV, 'run-1')).toEqual([]);
    expect(dequeueNextUserInput(CONV)?.id).toBe(item.id);

    const other = enqueueUserInput(CONV, '再改一下')!;
    expect(takeSteeringInputsNow(CONV, 'run-1').map((entry) => entry.id)).toEqual([other.id]);
    sendQueuedInputAfterRun(CONV, other.id);
    expect(getQueuedInputs(CONV)).toEqual([]);
  });

  // Found by the tester: after a Stop the queue stays paused until the user
  // presses 「继续队列」, and a message typed into the NEXT run the user starts
  // was never read by it. A steering entry is bound to the run it was typed
  // into, and the take of that run ignores the after-run pause.
  it('a message typed into the next run after a Stop still steers that run', () => {
    enqueueUserInput(CONV, '先别发邮件'); // typed into the stopped run
    endSteeringRun(CONV, 'run-1'); // the Stop ends the run's steering ...
    pauseUserInputQueue(CONV); // ... and pauses the queue
    // The user starts a new run by sending normally, then types into it.
    beginSteeringRun(CONV, 'run-c');
    const typedIntoNextRun = enqueueUserInput(CONV, '标题改成周报')!;
    expect(typedIntoNextRun.delivery).toBe('steer');

    expect(takeSteeringInputsNow(CONV, 'run-c').map((item) => item.id)).toEqual([typedIntoNextRun.id]);
  });

  // Found by the tester: a steering entry bound to no run could land in a run
  // it was never typed into. Stop on run A pauses the queue (A's message waits
  // as an after-run chip). The user sends a new message (run C) and types a
  // correction into C. C ends; the user presses 「继续队列」, the dispatcher
  // starts A's message as run D. Whatever happened to C's correction (C took
  // it, or it became its own turn), D must not receive it.
  it('after a Stop, a correction typed into the next run never lands in the run 「继续队列」 starts later', () => {
    const forA = enqueueUserInput(CONV, '先别发邮件')!;
    endSteeringRun(CONV, 'run-1'); // Stop on run A
    pauseUserInputQueue(CONV);
    beginSteeringRun(CONV, 'run-c');
    const forC = enqueueUserInput(CONV, '标题改成周报')!; // typed into run C
    takeSteeringInputsNow(CONV, 'run-c'); // C's take at its tool step
    endSteeringRun(CONV, 'run-c'); // C ends

    resumeUserInputQueue(CONV); // 「继续队列」 after C ended
    expect(dequeueNextUserInput(CONV)?.id).toBe(forA.id); // run D starts with A's message
    beginSteeringRun(CONV, 'run-d');
    const takenByD = takeSteeringInputsNow(CONV, 'run-d');

    expect(takenByD.map((item) => item.id)).not.toContain(forC.id);
  });

  it('a correction run C never took becomes its own turn after C, and run D does not take it either', () => {
    endSteeringRun(CONV, 'run-1');
    beginSteeringRun(CONV, 'run-c');
    const forC = enqueueUserInput(CONV, '最后再总结三句话')!; // C was writing its final answer
    endSteeringRun(CONV, 'run-c');

    const next = dequeueNextUserInput(CONV)!;
    expect(next.id).toBe(forC.id);
    expect(next.delivery).toBeUndefined();
    beginSteeringRun(CONV, 'run-d');
    expect(takeSteeringInputsNow(CONV, 'run-d')).toEqual([]);
  });
});
