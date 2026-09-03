import { describe, expect, it, vi } from 'vitest';
import {
  BROWSER_DENIAL_ABORT_THRESHOLD,
  createBrowserDenialTracker,
} from './browserDenialTracker';

describe('createBrowserDenialTracker', () => {
  it('ships with a threshold of two — "twice in a row" is the product rule', () => {
    expect(BROWSER_DENIAL_ABORT_THRESHOLD).toBe(2);
  });

  it('fires the abort action on the second consecutive denial, and only once', () => {
    const onThreshold = vi.fn();
    const tracker = createBrowserDenialTracker(onThreshold);

    tracker.reportDenial();
    expect(onThreshold).not.toHaveBeenCalled();
    expect(tracker.consecutiveDenials).toBe(1);
    expect(tracker.tripped).toBe(false);

    tracker.reportDenial();
    expect(onThreshold).toHaveBeenCalledTimes(1);
    expect(tracker.tripped).toBe(true);

    // Anything after the trip is inert: the run is already stopping.
    tracker.reportDenial();
    tracker.reportAllow();
    tracker.reportDenial();
    expect(onThreshold).toHaveBeenCalledTimes(1);
    expect(tracker.consecutiveDenials).toBe(2);
  });

  it('an allow between two denials resets the streak (deny, allow, deny → no abort)', () => {
    const onThreshold = vi.fn();
    const tracker = createBrowserDenialTracker(onThreshold);

    tracker.reportDenial();
    tracker.reportAllow();
    expect(tracker.consecutiveDenials).toBe(0);
    tracker.reportDenial();

    expect(onThreshold).not.toHaveBeenCalled();
    expect(tracker.tripped).toBe(false);
  });

  it('allows alone never trip anything', () => {
    const onThreshold = vi.fn();
    const tracker = createBrowserDenialTracker(onThreshold);
    for (let i = 0; i < 10; i += 1) tracker.reportAllow();
    expect(onThreshold).not.toHaveBeenCalled();
    expect(tracker.consecutiveDenials).toBe(0);
  });

  it('honours a custom threshold', () => {
    const onThreshold = vi.fn();
    const tracker = createBrowserDenialTracker(onThreshold, 3);
    tracker.reportDenial();
    tracker.reportDenial();
    expect(onThreshold).not.toHaveBeenCalled();
    tracker.reportDenial();
    expect(onThreshold).toHaveBeenCalledTimes(1);
  });
});
