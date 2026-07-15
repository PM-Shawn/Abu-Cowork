import { describe, it, expect } from 'vitest';
import { clampZoom, zoomIn, zoomOut, zoomByWheel, formatZoomPercent, ZOOM_MIN, ZOOM_MAX } from './zoom';

describe('zoom', () => {
  it('clampZoom bounds to [0.25, 3]', () => {
    expect(clampZoom(0.1)).toBe(ZOOM_MIN);
    expect(clampZoom(5)).toBe(ZOOM_MAX);
    expect(clampZoom(1)).toBe(1);
  });
  it('zoomIn / zoomOut step by 25% and clamp', () => {
    expect(zoomIn(1)).toBe(1.25);
    expect(zoomOut(1)).toBe(0.75);
    expect(zoomIn(3)).toBe(3);
    expect(zoomOut(0.25)).toBe(0.25);
  });
  it('zoomByWheel steps 10% by deltaY sign', () => {
    expect(zoomByWheel(1, -1)).toBe(1.1);
    expect(zoomByWheel(1, 1)).toBe(0.9);
  });
  it('formatZoomPercent rounds to integer percent', () => {
    expect(formatZoomPercent(1)).toBe('100%');
    expect(formatZoomPercent(0.25)).toBe('25%');
    expect(formatZoomPercent(1.1)).toBe('110%');
  });
});
