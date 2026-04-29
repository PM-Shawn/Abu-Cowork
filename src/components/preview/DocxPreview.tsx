import { useState, useEffect, useRef } from 'react';
import { readFile } from '@tauri-apps/plugin-fs';
import { useI18n } from '@/i18n';
import { Loader2 } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useFitToWidth } from '@/hooks/useFitToWidth';

export default function DocxPreview({ filePath }: { filePath: string }) {
  const { t } = useI18n();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
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
        const { renderAsync } = await import('docx-preview');

        if (cancelled || !containerRef.current) return;

        containerRef.current.innerHTML = '';

        await renderAsync(data, containerRef.current, undefined, {
          className: 'docx-preview-wrapper',
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: true,
          ignoreFonts: false,
          breakPages: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
        });
      } catch (err) {
        if (cancelled) return;
        console.error('[DocxPreview] Failed to render:', err);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [filePath]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-full p-4">
        <p className="text-[13px] text-red-500">{error}</p>
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
              className="docx-preview-container"
              style={{
                background: 'white',
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
