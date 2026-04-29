import { useEffect, useRef, useState } from 'react';
import { readFile } from '@tauri-apps/plugin-fs';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { Loader2, Presentation, FolderOpen } from 'lucide-react';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { getBaseName } from '@/utils/pathUtils';
import { useFitToWidth } from '@/hooks/useFitToWidth';

const RENDER_WIDTH = 960;
const RENDER_HEIGHT = 540;

/**
 * PptxPreview — renders all slides vertically (mode: 'list') and scales to fit panel width.
 */
export default function PptxPreview({ filePath }: { filePath: string }) {
  const { t } = useI18n();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const previewerRef = useRef<{ destroy: () => void } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { scale, scaledWidth, scaledHeight } = useFitToWidth(wrapperRef, containerRef, { padding: 16 });

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

        if (!cancelled) setLoading(false);
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
  }, [filePath]);

  if (error) {
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
      <div className="flex flex-col items-center justify-center h-full p-6 text-center gap-3">
        <div className="w-14 h-14 rounded-xl flex items-center justify-center bg-[var(--abu-bg-hover)]">
          <Presentation className="w-7 h-7 text-[var(--abu-text-tertiary)]" />
        </div>
        <div className="flex flex-col gap-1 max-w-[280px]">
          <p className="text-[13px] font-medium text-[var(--abu-text-primary)] truncate">
            {getBaseName(filePath)}
          </p>
          <p className="text-[12px] text-[var(--abu-text-tertiary)]">
            {t.panel.pptxPreviewUnavailable}
          </p>
        </div>
        <div className="flex items-center gap-2 mt-1">
          <Button variant="outline" size="sm" onClick={handleOpenWithDefaultApp}>
            <Presentation className="w-3.5 h-3.5 mr-1.5" />
            {t.panel.openWithPowerPoint}
          </Button>
          <Button variant="ghost" size="sm" onClick={handleShowInFinder}>
            <FolderOpen className="w-3.5 h-3.5 mr-1.5" />
            {t.panel.showInFinder}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-[var(--abu-bg-hover)]">
      {loading && (
        <div className="flex items-center justify-center h-full">
          <Loader2 className="w-5 h-5 text-[var(--abu-clay)] animate-spin" />
          <span className="ml-2 text-[13px] text-[var(--abu-text-tertiary)]">{t.panel.loadingDocument}</span>
        </div>
      )}
      <ScrollArea className={`flex-1 min-h-0 ${loading ? 'hidden' : ''}`}>
        <div ref={wrapperRef} className="p-4">
          <div
            style={{
              width: scaledWidth || '100%',
              height: scaledHeight,
              margin: '0 auto',
              overflow: 'hidden',
            }}
          >
            <div
              ref={containerRef}
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
