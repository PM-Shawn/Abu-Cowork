import { describe, expect, it } from 'vitest';
import { createComputerObservationContexts } from './observationContext';

const keyA = { conversationId: 'conversation-a', loopId: 'loop-a' };
const keyB = { conversationId: 'conversation-b', loopId: 'loop-b' };

describe('task-scoped Computer Use observation context', () => {
  it('does not reuse a screenshot or coordinate transform from another task', () => {
    const contexts = createComputerObservationContexts();
    contexts.record(keyA, {
      windowRef: 'wr-a',
      stateId: 'state-a',
      screenshotId: 'shot-a',
      scaleFactor: 2,
      origin: { x: 100, y: 50 },
    });
    contexts.record(keyB, {
      windowRef: 'wr-b',
      stateId: 'state-b',
      screenshotId: 'shot-b',
      scaleFactor: 1,
      origin: { x: 0, y: 0 },
    });

    expect(contexts.toScreenCoords(keyA, 10, 20)).toEqual({ x: 120, y: 90 });
    expect(() => contexts.requireScreenshot(keyB, 'shot-a')).toThrow(/screenshot-stale/);
    contexts.clear(keyA);
    expect(contexts.get(keyA)).toBeNull();
    expect(contexts.get(keyB)?.screenshotId).toBe('shot-b');
  });

  it('requires a screenshot to remain bound to the same WindowRef and state', () => {
    const contexts = createComputerObservationContexts();
    contexts.record(keyA, {
      windowRef: 'wr-a',
      stateId: 'state-a',
      screenshotId: 'shot-a',
      scaleFactor: 1.25,
      origin: { x: -100, y: 20 },
    });

    expect(contexts.requireScreenshot(keyA, 'shot-a', {
      windowRef: 'wr-a',
      stateId: 'state-a',
    })).toMatchObject({ screenshotId: 'shot-a' });
    expect(() => contexts.requireScreenshot(keyA, 'shot-a', {
      windowRef: 'wr-other',
      stateId: 'state-a',
    })).toThrow(/screenshot-stale/);
    for (const missing of [undefined, null, '']) {
      expect(() => contexts.requireScreenshot(keyA, missing, {
        windowRef: 'wr-a', stateId: 'state-a',
      })).toThrow(/screenshot-stale/);
    }
    expect(() => contexts.requireScreenshot(keyA, 'shot-a', {
      windowRef: 'wr-a',
      stateId: 'state-other',
    })).toThrow(/screenshot-stale/);
  });

  it('fails closed when no screenshot exists and replaces only the addressed task', () => {
    const contexts = createComputerObservationContexts();
    expect(() => contexts.toScreenCoords(keyA, 1, 2)).toThrow(/screenshot-required/);
    expect(() => contexts.requireScreenshot(keyA, null)).toThrow(/screenshot-required/);

    contexts.record(keyA, {
      windowRef: null,
      stateId: null,
      screenshotId: 'shot-first',
      scaleFactor: 1,
      origin: { x: 0, y: 0 },
    });
    contexts.record(keyA, {
      windowRef: 'wr-new',
      stateId: 'state-new',
      screenshotId: 'shot-new',
      scaleFactor: 2,
      origin: { x: 5, y: 6 },
    });

    expect(contexts.get(keyA)).toMatchObject({
      windowRef: 'wr-new', stateId: 'state-new', screenshotId: 'shot-new',
    });
    expect(() => contexts.requireScreenshot(keyA, 'shot-first')).toThrow(/screenshot-stale/);
  });
});
