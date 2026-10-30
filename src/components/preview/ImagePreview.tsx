import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { IconButton } from '@/components/ds/button';
import { AppIcons } from '@/components/ds/icons';
import { useI18n } from '@/i18n';
import { useToastStore } from '@/stores/toastStore';
import { cn } from '@/lib/utils';
import { clampImageZoom, IMAGE_ZOOM_MAX, IMAGE_ZOOM_MIN, nextImageRotation } from './imagePreviewMath';
import { useImageEditor } from './useImageEditor';
import { ImageComments } from './ImageComments';
import { imagePointFromClient } from '@/core/media/imageDraft';
import type { MediaFileRef } from '@/types/media';

// Panning a zoomed image re-renders the preview on every pointer move. The toolbar mounts a
// tooltip per button, so it takes only the zoom, the copied flag and stable handlers.
const ImageToolbar = memo(function ImageToolbar({ zoom, copied, onZoom, onRotate, onReset, onCopy }: {
  zoom: number;
  copied: boolean;
  onZoom: (next: number) => void;
  onRotate: (direction: -1 | 1) => void;
  onReset: () => void;
  onCopy: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center justify-center gap-1 p-1">
      <IconButton size="sm" icon={AppIcons.zoomOut} label={t.panel.imageZoomOut} onClick={() => onZoom(zoom - 0.25)} disabled={zoom <= IMAGE_ZOOM_MIN} />
      <span className="min-w-11 select-none text-center text-caption tabular-nums text-label-tertiary">
        {Math.round(zoom * 100)}%
      </span>
      <IconButton size="sm" icon={AppIcons.zoomIn} label={t.panel.imageZoomIn} onClick={() => onZoom(zoom + 0.25)} disabled={zoom >= IMAGE_ZOOM_MAX} />
      <div className="mx-1 h-4 w-px bg-separator" />
      <IconButton size="sm" icon={AppIcons.rotateLeft} label={t.panel.imageRotateLeft} onClick={() => onRotate(-1)} />
      <IconButton size="sm" icon={AppIcons.rotateRight} label={t.panel.imageRotateRight} onClick={() => onRotate(1)} />
      <IconButton size="sm" icon={AppIcons.fitView} label={t.panel.imageResetView} onClick={onReset} />
      <div className="mx-1 h-4 w-px bg-separator" />
      <IconButton
        size="sm"
        icon={copied ? AppIcons.done : AppIcons.copy}
        label={t.panel.imageCopy}
        // The button's own hover color would replace the success color under the pointer.
        className={copied ? 'text-success hover:text-success' : undefined}
        onClick={onCopy}
      />
    </div>
  );
});

export default function ImagePreview({ src, alt, conversationId, filePath, fileRef }: { src: string; alt: string; conversationId?: string; filePath?: string; fileRef?: MediaFileRef }) {
  const { t } = useI18n();
  const imageRef = useRef<HTMLImageElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const editor = useImageEditor(conversationId, filePath, fileRef);
  const [displaySize, setDisplaySize] = useState({ width: 0, height: 0 });
  const shownSource = editor.sourceUrl ?? src;

  useEffect(() => {
    const image = imageRef.current;
    if (!image) return;
    const observer = new ResizeObserver(() => setDisplaySize({ width: image.offsetWidth, height: image.offsetHeight }));
    observer.observe(image);
    return () => observer.disconnect();
  }, []);

  const imagePoint = (event: React.PointerEvent) => {
    const image = imageRef.current;
    if (!image || !image.offsetWidth || !image.offsetHeight) return null;
    const rect = image.getBoundingClientRect();
    return imagePointFromClient({ x: event.clientX, y: event.clientY }, {
      centerX: rect.x + rect.width / 2, centerY: rect.y + rect.height / 2,
      width: image.offsetWidth, height: image.offsetHeight, zoom, rotation,
    });
  };

  useEffect(() => {
    setZoom(1);
    setRotation(0);
    setOffset({ x: 0, y: 0 });
    setCopied(false);
  }, [src]);

  const resetView = useCallback(() => {
    setZoom(1);
    setRotation(0);
    setOffset({ x: 0, y: 0 });
  }, []);

  const changeZoom = useCallback((next: number) => {
    const clamped = clampImageZoom(next);
    setZoom(clamped);
    if (clamped <= 1) setOffset({ x: 0, y: 0 });
  }, []);

  const rotate = useCallback((direction: -1 | 1) => {
    setRotation((value) => nextImageRotation(value, direction));
  }, []);

  const copyImage = useCallback(async () => {
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
  }, [t]);

  const handleCopy = useCallback(() => {
    void copyImage();
  }, [copyImage]);

  return (
    <div
      data-testid="image-preview"
      className="relative flex h-full min-h-0 flex-col items-center overflow-hidden bg-code outline-none"
      onWheel={(event) => {
        if (!event.metaKey && !event.ctrlKey) return;
        event.preventDefault();
        changeZoom(zoom + (event.deltaY < 0 ? 0.25 : -0.25));
      }}
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{ backgroundImage: 'radial-gradient(circle, var(--ds-control-border) 0.7px, transparent 0.8px)', backgroundSize: '16px 16px' }}
      />

      {/* The hint and the double-click reset sit on the stage, a sibling of the toolbar: the hint
          never shows over a button's own tooltip, and two quick clicks on a button do not reset. */}
      <div
        ref={stageRef}
        tabIndex={-1}
        className={cn(
          'relative flex min-h-0 w-full flex-1 items-center justify-center p-8',
          editor.drawing ? 'cursor-crosshair' : zoom > 1 ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-default',
        )}
        title={editor.drawing ? undefined : t.panel.imageDoubleClickReset}
        onDoubleClick={editor.drawing ? undefined : resetView}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          if (editor.drawing) {
            const point = imagePoint(event);
            if (!point) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            editor.pointerDown(point);
            return;
          }
          if (zoom <= 1) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = { x: event.clientX, y: event.clientY, offsetX: offset.x, offsetY: offset.y };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (editor.drawing) {
            const point = imagePoint(event);
            if (point) editor.pointerMove(point);
            return;
          }
          if (!dragRef.current) return;
          setOffset({
            x: dragRef.current.offsetX + event.clientX - dragRef.current.x,
            y: dragRef.current.offsetY + event.clientY - dragRef.current.y,
          });
        }}
        onPointerUp={(event) => {
          if (editor.drawing) editor.pointerUp();
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          dragRef.current = null;
          setDragging(false);
        }}
        onPointerCancel={() => {
          editor.pointerCancel();
          dragRef.current = null;
          setDragging(false);
        }}
      >
        <img
          ref={imageRef}
          src={shownSource}
          alt={alt}
          draggable={false}
          className="max-h-full max-w-full select-none object-contain shadow-panel"
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom}) rotate(${rotation}deg)` }}
        />
        {editor.overlay && editor.dimensions && <svg
          className="pointer-events-none absolute"
          width={displaySize.width} height={displaySize.height}
          viewBox={`0 0 ${editor.dimensions.width} ${editor.dimensions.height}`}
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom}) rotate(${rotation}deg)` }}
          aria-hidden="true"
        >{editor.overlay}</svg>}
        <ImageComments comments={editor.comments} editor={editor.commentEditor}
          width={displaySize.width} height={displaySize.height} zoom={zoom} rotation={rotation} offset={offset}
          onOpen={editor.openComment} onClose={editor.closeComment} onChange={editor.changeComment}
          onDelete={editor.deleteComment} onFocusUnplaced={() => stageRef.current?.focus({ preventScroll: true })} />
      </div>

      <div className="relative flex w-full shrink-0 justify-center px-4 pb-4">
        <div className="w-fit max-w-full rounded-panel bg-raised p-1 shadow-float">
          {editor.controls}
          <ImageToolbar zoom={zoom} copied={copied} onZoom={changeZoom} onRotate={rotate} onReset={resetView} onCopy={handleCopy} />
        </div>
      </div>
    </div>
  );
}
