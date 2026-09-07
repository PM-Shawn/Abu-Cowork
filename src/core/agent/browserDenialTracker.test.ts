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

  describe('a site grant cannot dilute a scripting refusal (U5 R1)', () => {
    it('the dodge sequence still aborts: execute_js denied → click auto-allowed by a grant → execute_js denied', () => {
      const onThreshold = vi.fn();
      const tracker = createBrowserDenialTracker(onThreshold);

      tracker.reportDenial('scripting');
      // A standing/conversation site grant let a CLICK through. A grant can
      // structurally never authorize execute_js, so it must not wipe the
      // scripting refusal that came before it.
      tracker.reportAllow('grant');
      expect(tracker.consecutiveDenials).toBe(1);

      tracker.reportDenial('scripting');
      expect(onThreshold).toHaveBeenCalledTimes(1);
    });

    it('a grant-consented allow DOES reset a streak of ordinary refusals', () => {
      const onThreshold = vi.fn();
      const tracker = createBrowserDenialTracker(onThreshold);

      tracker.reportDenial('other');
      tracker.reportAllow('grant');
      expect(tracker.consecutiveDenials).toBe(0);
      tracker.reportDenial('other');
      expect(onThreshold).not.toHaveBeenCalled();
    });

    it('a DIALOG-confirmed allow resets everything, scripting included', () => {
      const onThreshold = vi.fn();
      const tracker = createBrowserDenialTracker(onThreshold);

      tracker.reportDenial('scripting');
      tracker.reportAllow('dialog');
      expect(tracker.consecutiveDenials).toBe(0);
      tracker.reportDenial('scripting');
      expect(onThreshold).not.toHaveBeenCalled();
    });

    it('defaults are the strict reading: an unlabelled denial is scripting-safe, an unlabelled allow is a dialog', () => {
      const onThreshold = vi.fn();
      const tracker = createBrowserDenialTracker(onThreshold);
      // Legacy call shape (no argument) keeps the pre-U5 semantics exactly.
      tracker.reportDenial();
      tracker.reportAllow();
      expect(tracker.consecutiveDenials).toBe(0);
    });
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
