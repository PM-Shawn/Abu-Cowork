import { describe, expect, it } from 'vitest';
import { clampImageZoom, nextImageRotation } from './imagePreviewMath';

describe('ImagePreview helpers', () => {
  it('clamps zoom to the supported range', () => {
    expect(clampImageZoom(0)).toBe(0.25);
    expect(clampImageZoom(1.75)).toBe(1.75);
    expect(clampImageZoom(8)).toBe(4);
  });

  it('rotates in normalized quarter turns', () => {
    expect(nextImageRotation(0, 1)).toBe(90);
    expect(nextImageRotation(0, -1)).toBe(270);
    expect(nextImageRotation(270, 1)).toBe(0);
  });
});
