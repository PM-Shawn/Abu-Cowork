import { useState, useEffect, useRef } from 'react';
import { readFile } from '@tauri-apps/plugin-fs';
import { useI18n } from '@/i18n';
import { InlineMessage } from '@/components/ds/inline-message';
import { ScrollArea } from '@/components/ds/scroll-area';
import { Spinner } from '@/components/ds/spinner';
import { useFitToWidth } from '@/hooks/useFitToWidth';
import { cn } from '@/lib/utils';

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
      <div className="flex h-full items-center justify-center p-4">
        <InlineMessage tone="danger">{error}</InlineMessage>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-code">
      {loading && (
        <div className="flex h-full items-center justify-center">
          <Spinner label={t.panel.loadingDocument} />
        </div>
      )}
      <ScrollArea className={cn('min-h-0 flex-1', loading && 'hidden')}>
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
              data-page-canvas
              className="docx-preview-container"
              style={{
                background: 'var(--ds-page-canvas)',
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
