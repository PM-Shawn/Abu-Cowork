/**
 * Queue staging semantics (Codex-style): queued messages live OUTSIDE the
 * transcript in a cancellable staging area and only become chat messages
 * when the running loop drains them.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  enqueueUserInput,
  enqueueUserInputWithId,
  drainQueuedInputs,
  clearInputQueue,
  getQueuedInputs,
  removeQueuedInput,
} from './userInputQueue';

const CONV = 'conv-queue-test';

describe('userInputQueue staging', () => {
  beforeEach(() => clearInputQueue(CONV));

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
