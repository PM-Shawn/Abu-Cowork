import { useEffect, useRef, useState } from 'react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { useI18n } from '@/i18n';
import { redactFailureText } from '@/core/diagnostic/scrub';
import { Button } from '@/components/ds/button';
import { EmptyState } from '@/components/ds/empty-state';
import { AppIcons } from '@/components/ds/icons';
import { ScrollArea } from '@/components/ds/scroll-area';
import { Spinner } from '@/components/ds/spinner';
import { getBaseName } from '@/utils/pathUtils';
import { useFitToWidth } from '@/hooks/useFitToWidth';
import { cn } from '@/lib/utils';
import { normalizeSlideBackgrounds } from './pptxSlideBackground';

const RENDER_WIDTH = 960;
const RENDER_HEIGHT = 540;

/**
 * PptxPreview — renders all slides of the deck's bytes vertically (mode: 'list') and scales
 * to fit panel width. `filePath` names the deck and is what the two ways out open.
 */
export default function PptxPreview({ filePath, data }: { filePath: string; data: Uint8Array<ArrayBuffer> }) {
  const { t } = useI18n();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const previewerRef = useRef<{ destroy: () => void } | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const { scale, scaledWidth, scaledHeight } = useFitToWidth(wrapperRef, containerRef, { padding: 16 });

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        // The renderer takes an ArrayBuffer. Bytes that fill their buffer are handed over as
        // they are; only a view into a larger buffer is copied out.
        const arrayBuffer = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
          ? data.buffer
          : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);

        const { init } = await import('pptx-preview');

        if (cancelled || !containerRef.current) return;

        if (previewerRef.current) {
          previewerRef.current.destroy();
          previewerRef.current = null;
        }
        containerRef.current.innerHTML = '';

        const previewer = init(containerRef.current, {
          width: RENDER_WIDTH,
          height: RENDER_HEIGHT,
          mode: 'list',
        });

        previewerRef.current = previewer;
        await previewer.preview(arrayBuffer);

        if (!cancelled && containerRef.current) {
          normalizeSlideBackgrounds(containerRef.current);
        }

        if (!cancelled) {
          setFailed(false);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          console.error('[PptxPreview] Failed to render:', redactFailureText(err instanceof Error ? err.message : String(err)));
          setFailed(true);
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
  }, [data]);

  const handleOpenWithDefaultApp = async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const platform = navigator.platform.toLowerCase();
      const command = platform.includes('win')
        ? `start "" "${filePath}"`
        : platform.includes('linux')
          ? `xdg-open "${filePath}"`
          : `open "${filePath}"`;
      await invoke('run_shell_command', {
        command,
        cwd: null,
        background: true,
        timeout: 5,
        sandboxEnabled: false,
      });
    } catch (err) {
      console.error('[PptxPreview] Failed to open with default app:', err);
    }
  };

  const handleShowInFinder = async () => {
    try {
      await revealItemInDir(filePath);
    } catch (err) {
      console.error('[PptxPreview] Failed to reveal in dir:', err);
    }
  };

  return (
    <div className={cn('flex h-full flex-col', !failed && 'bg-code')}>
      {failed ? (
        <div className="flex h-full items-center justify-center">
          <EmptyState
            icon={AppIcons.fileSlides}
            title={<span className="block max-w-70 truncate">{getBaseName(filePath)}</span>}
            description={t.panel.pptxPreviewUnavailable}
            action={(
              <div className="flex items-center gap-2">
                <Button variant="secondary" icon={AppIcons.fileSlides} onClick={handleOpenWithDefaultApp}>
                  {t.panel.openWithPowerPoint}
                </Button>
                <Button variant="plain" icon={AppIcons.folderOpen} onClick={handleShowInFinder}>
                  {t.panel.showInFinder}
                </Button>
              </div>
            )}
          />
        </div>
      ) : loading && (
        <div className="flex h-full items-center justify-center">
          <Spinner label={t.panel.loadingDocument} />
        </div>
      )}
      {/* The slide container stays mounted through loading and failure: the renderer draws into it. */}
      <ScrollArea className={cn('min-h-0 flex-1', (loading || failed) && 'hidden')}>
        <div ref={wrapperRef} className="p-4">
          <div
            style={{
              width: scaledWidth || '100%',
              height: scaledHeight,
              margin: '0 auto',
              overflow: 'hidden',
            }}
          >
            {/* Slides are white paper in every appearance; the marker gives their text the page selection color. */}
            <div
              ref={containerRef}
              data-page-canvas
              className="pptx-preview-container"
              style={{
                transform: `scale(${scale})`,
                transformOrigin: 'top left',
                width: 'max-content',
              }}
            />
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
