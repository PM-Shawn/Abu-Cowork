import { describe, expect, it } from 'vitest';
import { clampDiagramZoom, diagramZoomLimits, resolveDiagramZoom } from './diagramZoom';

describe('diagram viewer sizing', () => {
  const viewport = { width: 952, height: 592 };
  it('enlarges an ordinary diagram to the available width', () => {
    const content = { width: 636.68, height: 302 };
    const scale = resolveDiagramZoom(content, viewport, { kind: 'initial' });
    expect(content.width * scale).toBeCloseTo(952);
    expect(content.height * scale).toBeLessThan(viewport.height);
  });

  it('keeps a tall diagram readable and allows a separate whole-diagram fit', () => {
    const content = { width: 400, height: 4000 };
    expect(resolveDiagramZoom(content, viewport, { kind: 'initial' })).toBe(1);
    expect(resolveDiagramZoom(content, viewport, { kind: 'fit' })).toBeCloseTo(0.148);
    expect(diagramZoomLimits(content, viewport).min).toBeCloseTo(0.148);
  });

  it('fits a wide diagram and limits automatic enlargement of a small diagram', () => {
    expect(resolveDiagramZoom({ width: 2000, height: 200 }, viewport, { kind: 'initial' })).toBeCloseTo(0.476);
    expect(resolveDiagramZoom({ width: 100, height: 50 }, viewport, { kind: 'initial' })).toBe(2);
  });

  it('preserves a manually chosen scale when the viewport grows', () => {
    expect(resolveDiagramZoom({ width: 400, height: 4000 }, { width: 1200, height: 1200 }, { kind: 'manual', scale: 0.148 })).toBe(0.148);
  });

  it('bounds manual inputs while allowing a very long diagram to fit', () => {
    const content = { width: 400, height: 4000 };
    expect(clampDiagramZoom(content, viewport, 10)).toBe(4);
    expect(clampDiagramZoom(content, viewport, -1)).toBeCloseTo(0.148);
    expect(clampDiagramZoom(content, viewport, 1)).toBe(1);
  });

  it.each([0, -1, Infinity, NaN])('rejects invalid dimensions: %s', (width) => {
    expect(() => resolveDiagramZoom({ width, height: 300 }, viewport, { kind: 'fit' })).toThrow();
  });
});
