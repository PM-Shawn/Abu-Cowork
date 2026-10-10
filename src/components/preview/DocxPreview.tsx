import { useState, useEffect, useRef } from 'react';
import { useI18n } from '@/i18n';
import { redactFailureText } from '@/core/diagnostic/scrub';
import { InlineMessage } from '@/components/ds/inline-message';
import { ScrollArea } from '@/components/ds/scroll-area';
import { Spinner } from '@/components/ds/spinner';
import { useFitToWidth } from '@/hooks/useFitToWidth';
import { cn } from '@/lib/utils';

const RENDER_OPTIONS = {
  className: 'docx-preview-wrapper',
  inWrapper: true,
  ignoreWidth: false,
  ignoreHeight: true,
  ignoreFonts: false,
  breakPages: true,
  renderHeaders: true,
  renderFooters: true,
  renderFootnotes: true,
};

/** Draws the bytes of a Word document. A new `data` draws over the pages on screen. */
export default function DocxPreview({ data }: { data: Uint8Array<ArrayBuffer> }) {
  const { t } = useI18n();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const { scale, scaledWidth, scaledHeight } = useFitToWidth(wrapperRef, containerRef, { padding: 16 });

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const { parseAsync, renderDocument } = await import('docx-preview');
        if (cancelled) return;

        // Reading the bytes takes time and touches no page. Only the read that is still the
        // newest goes on to draw, so a slow read of earlier bytes never replaces later ones.
        const parsed = await parseAsync(data, RENDER_OPTIONS);
        if (cancelled || !containerRef.current) return;

        // The renderer empties the container and writes the pages in one step, in the document,
        // where the shapes it measures on the next frame have a layout.
        await renderDocument(parsed, containerRef.current, undefined, RENDER_OPTIONS);
        if (!cancelled) setFailed(false);
      } catch (err) {
        if (cancelled) return;
        console.error('[DocxPreview] Failed to render:', redactFailureText(err instanceof Error ? err.message : String(err)));
        setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [data]);

  return (
    <div className={cn('flex h-full flex-col', !failed && 'bg-code')}>
      {failed ? (
        <div className="flex h-full items-center justify-center p-4">
          <InlineMessage tone="danger">{t.panel.failedToReadFile}</InlineMessage>
        </div>
      ) : loading && (
        <div className="flex h-full items-center justify-center">
          <Spinner label={t.panel.loadingDocument} />
        </div>
      )}
      {/* The page container stays mounted through loading and failure: the renderer draws into it. */}
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
