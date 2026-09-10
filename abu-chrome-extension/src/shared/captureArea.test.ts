import { describe, it, expect } from 'vitest';
import { noCaptureAreaRefusal } from './captureArea';

describe('noCaptureAreaRefusal', () => {
  it('passes a page that has a viewport and something to scroll', () => {
    expect(noCaptureAreaRefusal(4320, 720)).toBeNull();
    expect(noCaptureAreaRefusal(720, 720)).toBeNull();
  });

  it('refuses a page whose scroll height measures zero', () => {
    const refusal = noCaptureAreaRefusal(0, 720);
    expect(refusal).toContain('0');
    expect(refusal).toMatch(/screenshot/);
  });

  it('refuses a viewport that measures zero', () => {
    expect(noCaptureAreaRefusal(4320, 0)).toMatch(/screenshot/);
  });

  it('refuses dimensions that are not finite positive numbers', () => {
    expect(noCaptureAreaRefusal(Number.NaN, 720)).toMatch(/screenshot/);
    expect(noCaptureAreaRefusal(4320, Number.POSITIVE_INFINITY)).toMatch(/screenshot/);
    expect(noCaptureAreaRefusal(-1, 720)).toMatch(/screenshot/);
  });
});
