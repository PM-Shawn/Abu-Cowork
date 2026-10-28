import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, IconButton } from '@/components/ds/button';
import { AppIcons } from '@/components/ds/icons';
import { Tooltip } from '@/components/ds/tooltip';
import { useI18n } from '@/i18n';
import { clampDiagramZoom, diagramZoomLimits, resolveDiagramZoom, type DiagramSize, type DiagramZoom } from './diagramZoom';

const CONTENT_PADDING = 24;

export default function DiagramViewer({ svg, naturalSize }: { svg: string; naturalSize: DiagramSize }) {
  const { t } = useI18n();
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const [available, setAvailable] = useState<DiagramSize | null>(null);
  const [preference, setPreference] = useState<DiagramZoom>({ kind: 'initial' });
  const frame = useRef<HTMLIFrameElement>(null);
  const anchor = useRef<{ clientX: number; clientY: number; x: number; y: number } | null>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const scale = available ? resolveDiagramZoom(naturalSize, available, preference) : 1;
  const limits = available ? diagramZoomLimits(naturalSize, available) : null;
  // Mermaid has already rendered this SVG under its strict security policy. The frame runs no scripts.
  const frameDocument = useMemo(() => `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#fff}
    svg{display:block;width:100%!important;height:100%!important;max-width:none!important}
    </style></head><body>${svg}</body></html>`, [svg]);

  useLayoutEffect(() => {
    if (!viewport) return;
    const measure = () => {
      const width = viewport.clientWidth - CONTENT_PADDING * 2;
      const height = viewport.clientHeight - CONTENT_PADDING * 2;
      if (width > 0 && height > 0) setAvailable({ width, height });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    measure();
    return () => observer.disconnect();
  }, [viewport]);

  useLayoutEffect(() => {
    const point = anchor.current;
    if (!point || !viewport || !frame.current) return;
    const rect = frame.current.getBoundingClientRect();
    viewport.scrollBy(rect.left + point.x * scale - point.clientX, rect.top + point.y * scale - point.clientY);
    anchor.current = null;
  }, [scale, viewport]);

  function keepPoint(clientX?: number, clientY?: number) {
    if (!viewport || !frame.current) return;
    const bounds = viewport.getBoundingClientRect();
    const x = clientX ?? bounds.left + viewport.clientWidth / 2;
    const y = clientY ?? bounds.top + viewport.clientHeight / 2;
    const rect = frame.current.getBoundingClientRect();
    anchor.current = { clientX: x, clientY: y, x: (x - rect.left) / scale, y: (y - rect.top) / scale };
  }

  function zoom(next: number) {
    if (!available) return;
    const nextScale = clampDiagramZoom(naturalSize, available, next);
    if (nextScale === scale) return;
    keepPoint();
    setPreference({ kind: 'manual', scale: nextScale });
  }

  useEffect(() => {
    if (!viewport) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      if (!frame.current || !available) return;
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? viewport.clientHeight : 1;
      const factor = Math.exp(-Math.max(-100, Math.min(100, event.deltaY * unit)) * 0.002);
      const nextScale = clampDiagramZoom(naturalSize, available, scale * factor);
      if (nextScale === scale) return;
      const rect = frame.current.getBoundingClientRect();
      anchor.current = {
        clientX: event.clientX, clientY: event.clientY,
        x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale,
      };
      setPreference({ kind: 'manual', scale: nextScale });
    };
    viewport.addEventListener('wheel', wheel, { passive: false });
    return () => viewport.removeEventListener('wheel', wheel);
  }, [viewport, scale, available, naturalSize]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-diagram-viewer>
      <div className="flex h-12 shrink-0 items-center justify-end gap-1 border-b border-separator bg-raised pl-3 pr-14">
        <IconButton icon={AppIcons.zoomOut} label={t.panel.pdfZoomOut} disabled={!limits || scale <= limits.min} onClick={() => zoom(scale - 0.25)} />
        <Tooltip content={t.panel.previewActualSize}>
          <Button variant="plain" size="sm" className="w-16 tabular-nums" aria-label={t.panel.previewActualSize} onClick={() => zoom(1)}>
            {scale < 0.01 ? (scale * 100).toFixed(1) : Math.round(scale * 100)}%
          </Button>
        </Tooltip>
        <IconButton icon={AppIcons.zoomIn} label={t.panel.pdfZoomIn} disabled={!limits || scale >= limits.max} onClick={() => zoom(scale + 0.25)} />
        <IconButton icon={AppIcons.fitView} label={t.panel.previewFitWindow} onClick={() => {
          anchor.current = null;
          viewport?.scrollTo(0, 0);
          setPreference({ kind: 'fit' });
        }} />
      </div>
      <div
        ref={setViewport}
        data-diagram-viewport
        role="region"
        aria-label={t.chat.htmlWidgetFullscreen}
        tabIndex={0}
        className="min-h-0 flex-1 touch-none overflow-auto bg-page-canvas p-6 outline-none"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop };
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          event.currentTarget.scrollLeft = drag.current.left + drag.current.x - event.clientX;
          event.currentTarget.scrollTop = drag.current.top + drag.current.y - event.clientY;
        }}
        onPointerUp={() => { drag.current = null; }}
        onLostPointerCapture={() => { drag.current = null; }}
      >
        <div className="flex min-h-full min-w-full">
          <iframe
            ref={frame}
            title={t.chat.htmlWidgetFullscreen}
            srcDoc={frameDocument}
            sandbox=""
            tabIndex={-1}
            className="pointer-events-none m-auto shrink-0 border-0"
            style={{ width: naturalSize.width * scale, height: naturalSize.height * scale }}
          />
        </div>
      </div>
    </div>
  );
}
