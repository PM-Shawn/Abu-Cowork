import { useEffect, useRef, useState, useCallback } from 'react';
import { readFile } from '@tauri-apps/plugin-fs';
import { Loader2 } from 'lucide-react';
import { useI18n } from '@/i18n';

// Render at high resolution for crisp display, then CSS-scale to fit panel
const RENDER_WIDTH = 960;
const RENDER_HEIGHT = 540;

/**
 * PptxPreview — renders PPTX slides using pptx-preview library (pure browser).
 * Supports shapes, text, images, charts, tables, diagrams.
 * Auto-scales to fit the panel width.
 */
export default function PptxPreview({ filePath }: { filePath: string }) {
  const { t } = useI18n();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const previewerRef = useRef<{ destroy: () => void } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);

  // Compute scale to fit container width
  const updateScale = useCallback(() => {
    if (!wrapperRef.current) return;
    const panelWidth = wrapperRef.current.clientWidth;
    if (panelWidth > 0) {
      setScale(Math.min(1, (panelWidth - 16) / RENDER_WIDTH)); // 16px padding
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);

      try {
        const data = await readFile(filePath);
        const arrayBuffer = data.buffer.slice(
          data.byteOffset,
          data.byteOffset + data.byteLength
        );

        const { init } = await import('pptx-preview');

        if (cancelled || !containerRef.current) return;

        // Cleanup previous
        if (previewerRef.current) {
          previewerRef.current.destroy();
          previewerRef.current = null;
        }
        containerRef.current.innerHTML = '';

        const previewer = init(containerRef.current, {
          width: RENDER_WIDTH,
          height: RENDER_HEIGHT,
          mode: 'slide',
        });

        previewerRef.current = previewer;
        await previewer.preview(arrayBuffer);

        if (!cancelled) {
          setLoading(false);
          // Calculate scale after rendering
          requestAnimationFrame(updateScale);
        }
      } catch (err) {
        if (!cancelled) {
          console.error('[PptxPreview] Failed to render:', err);
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    };

    load();

    return () => {
      cancelled = true;
      if (previewerRef.current) {
        previewerRef.current.destroy();
        previewerRef.current = null;
      }
    };
  }, [filePath, updateScale]);

  // Recalculate scale on resize
  useEffect(() => {
    if (loading) return;
    const observer = new ResizeObserver(updateScale);
    if (wrapperRef.current) observer.observe(wrapperRef.current);
    return () => observer.disconnect();
  }, [loading, updateScale]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-full p-4">
        <p className="text-[13px] text-red-500 text-center max-w-[280px]">{error}</p>
      </div>
    );
  }

  return (
    <div ref={wrapperRef} className="flex flex-col h-full bg-[var(--abu-bg-hover)] overflow-auto">
      {loading && (
        <div className="flex items-center justify-center h-full">
          <Loader2 className="w-5 h-5 text-[var(--abu-clay)] animate-spin" />
          <span className="ml-2 text-[13px] text-[var(--abu-text-tertiary)]">{t.panel.loadingDocument}</span>
        </div>
      )}
      <div
        className={loading ? 'hidden' : ''}
        style={{
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
          width: RENDER_WIDTH,
          marginLeft: `${((wrapperRef.current?.clientWidth || 0) - RENDER_WIDTH * scale) / 2}px`,
        }}
      >
        <div ref={containerRef} className="pptx-preview-container" />
      </div>
      {/* Spacer to account for scaled height */}
      {!loading && (
        <div style={{ height: Math.max(0, RENDER_HEIGHT * scale - RENDER_HEIGHT) }} />
      )}
    </div>
  );
}
