import { describe, expect, it } from 'vitest';
import { clampPdfScale, nextPdfRotation } from './pdfPreviewMath';

describe('PdfPreview helpers', () => {
  it('clamps manual zoom to a readable range', () => {
    expect(clampPdfScale(0.1)).toBe(0.5);
    expect(clampPdfScale(1.25)).toBe(1.25);
    expect(clampPdfScale(8)).toBe(4);
  });

  it('rotates clockwise and wraps at 360 degrees', () => {
    expect(nextPdfRotation(0)).toBe(90);
    expect(nextPdfRotation(270)).toBe(0);
  });
});
