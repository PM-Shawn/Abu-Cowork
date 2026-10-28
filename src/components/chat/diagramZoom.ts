export interface DiagramSize { width: number; height: number }
export type DiagramZoom = { kind: 'initial' } | { kind: 'fit' } | { kind: 'manual'; scale: number };

export function diagramZoomLimits(content: DiagramSize, viewport: DiagramSize) {
  for (const value of [content.width, content.height, viewport.width, viewport.height]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error('Diagram dimensions must be positive and finite');
  }
  const fit = Math.min(viewport.width / content.width, viewport.height / content.height, 4);
  return { fit, min: Math.min(0.25, fit), max: 4 };
}

export function resolveDiagramZoom(content: DiagramSize, viewport: DiagramSize, preference: DiagramZoom): number {
  const { fit } = diagramZoomLimits(content, viewport);
  if (preference.kind === 'fit') return fit;
  if (preference.kind === 'manual') return preference.scale;
  return Math.min(2, viewport.width / content.width, Math.max(1, viewport.height / content.height));
}

export function clampDiagramZoom(content: DiagramSize, viewport: DiagramSize, scale: number): number {
  if (!Number.isFinite(scale)) throw new Error('Diagram scale must be finite');
  const { min, max } = diagramZoomLimits(content, viewport);
  return Math.min(max, Math.max(min, scale));
}
