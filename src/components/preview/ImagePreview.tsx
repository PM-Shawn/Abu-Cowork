import { useEffect, useRef, useState } from 'react';
import { Check, Copy, RotateCcw, RotateCw, Scan, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { useToastStore } from '@/stores/toastStore';
import { cn } from '@/lib/utils';
import { clampImageZoom, IMAGE_ZOOM_MAX, IMAGE_ZOOM_MIN, nextImageRotation } from './imagePreviewMath';

export default function ImagePreview({ src, alt }: { src: string; alt: string }) {
  const { t } = useI18n();
  const imageRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setZoom(1);
    setRotation(0);
    setOffset({ x: 0, y: 0 });
    setCopied(false);
  }, [src]);

  const resetView = () => {
    setZoom(1);
    setRotation(0);
    setOffset({ x: 0, y: 0 });
  };

  const changeZoom = (next: number) => {
    const clamped = clampImageZoom(next);
    setZoom(clamped);
    if (clamped <= 1) setOffset({ x: 0, y: 0 });
  };

  const copyImage = async () => {
    try {
      const image = imageRef.current;
      if (!image || image.naturalWidth === 0 || typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
        throw new Error('Image clipboard is unavailable');
      }
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas is unavailable');
      context.drawImage(image, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Image conversion failed')), 'image/png');
      });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
      useToastStore.getState().addToast({ type: 'success', title: t.panel.imageCopied });
    } catch (error) {
      console.error('[ImagePreview] Failed to copy image:', error);
      useToastStore.getState().addToast({ type: 'error', title: t.panel.imageCopyFailed });
    }
  };

  return (
    <div
      className="relative flex h-full min-h-0 items-center justify-center overflow-hidden bg-[var(--abu-bg-active)] outline-none"
      onDoubleClick={resetView}
      onWheel={(event) => {
        if (!event.metaKey && !event.ctrlKey) return;
        event.preventDefault();
        changeZoom(zoom + (event.deltaY < 0 ? 0.25 : -0.25));
      }}
      title={t.panel.imageDoubleClickReset}
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{ backgroundImage: 'radial-gradient(circle, var(--abu-border-hover) 0.7px, transparent 0.8px)', backgroundSize: '16px 16px' }}
      />

      <div
        className={cn(
          'relative flex h-full w-full items-center justify-center p-8',
          zoom > 1 ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-default',
        )}
        onPointerDown={(event) => {
          if (zoom <= 1) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = { x: event.clientX, y: event.clientY, offsetX: offset.x, offsetY: offset.y };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (!dragRef.current) return;
          setOffset({
            x: dragRef.current.offsetX + event.clientX - dragRef.current.x,
            y: dragRef.current.offsetY + event.clientY - dragRef.current.y,
          });
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          dragRef.current = null;
          setDragging(false);
        }}
        onPointerCancel={() => {
          dragRef.current = null;
          setDragging(false);
        }}
      >
        <img
          ref={imageRef}
          src={src}
          alt={alt}
          draggable={false}
          className="max-h-full max-w-full select-none object-contain shadow-[0_18px_45px_rgba(35,31,23,0.12)] transition-transform duration-150 ease-out"
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom}) rotate(${rotation}deg)` }}
        />
      </div>

      <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-base)] p-1 shadow-[0_10px_30px_rgba(35,31,23,0.13)]">
        <Button variant="ghost" size="icon-xs" onClick={() => changeZoom(zoom - 0.25)} disabled={zoom <= IMAGE_ZOOM_MIN} title={t.panel.imageZoomOut}>
          <ZoomOut className="size-3.5" strokeWidth={1.6} />
        </Button>
        <span className="min-w-11 select-none text-center text-caption tabular-nums text-[var(--abu-text-tertiary)]">
          {Math.round(zoom * 100)}%
        </span>
        <Button variant="ghost" size="icon-xs" onClick={() => changeZoom(zoom + 0.25)} disabled={zoom >= IMAGE_ZOOM_MAX} title={t.panel.imageZoomIn}>
          <ZoomIn className="size-3.5" strokeWidth={1.6} />
        </Button>
        <div className="mx-1 h-4 w-px bg-[var(--abu-border-subtle)]" />
        <Button variant="ghost" size="icon-xs" onClick={() => setRotation((value) => nextImageRotation(value, -1))} title={t.panel.imageRotateLeft}>
          <RotateCcw className="size-3.5" strokeWidth={1.6} />
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={() => setRotation((value) => nextImageRotation(value, 1))} title={t.panel.imageRotateRight}>
          <RotateCw className="size-3.5" strokeWidth={1.6} />
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={resetView} title={t.panel.imageResetView}>
          <Scan className="size-3.5" strokeWidth={1.6} />
        </Button>
        <div className="mx-1 h-4 w-px bg-[var(--abu-border-subtle)]" />
        <Button variant="ghost" size="icon-xs" onClick={() => void copyImage()} title={t.panel.imageCopy}>
          {copied ? <Check className="size-3.5 text-[var(--abu-success)]" strokeWidth={1.8} /> : <Copy className="size-3.5" strokeWidth={1.6} />}
        </Button>
      </div>
    </div>
  );
}
