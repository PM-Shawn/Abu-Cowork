import { useEffect, useMemo, useRef, useState } from 'react';
import { readFile } from '@tauri-apps/plugin-fs';
import { Document, Page, pdfjs } from 'react-pdf';
import { useI18n } from '@/i18n';
import { format } from '@/i18n';
import { Loader2, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, RotateCw, ScanLine } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { clampPdfScale, nextPdfRotation, PDF_SCALE_MAX, PDF_SCALE_MIN } from './pdfPreviewMath';

import 'react-pdf/dist/Page/TextLayer.css';
import 'react-pdf/dist/Page/AnnotationLayer.css';

// Resolve the pdf.js worker through the bundler (Vite `?url`) rather than a
// bare `/public` path: a `/public` .mjs can't be loaded as an ESM module worker
// in Vite dev (pdf.js then falls back to `import()`-ing it, which Vite blocks),
// so PDF preview errored in dev. `?url` makes Vite serve/bundle it correctly in
// both dev and production.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface PdfReadingState {
  page: number;
  scale: number;
  rotation: number;
  fitWidth: boolean;
}

// Keep reading position while the workspace tab remains alive. This is
// intentionally session-only: reopening the app starts from a predictable
// first page and does not add another persisted preference surface.
const readingState = new Map<string, PdfReadingState>();

function LoadingIndicator({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 h-full">
      <Loader2 className="w-5 h-5 text-[var(--abu-clay)] animate-spin" />
      {label && <span className="text-body text-[var(--abu-text-tertiary)]">{label}</span>}
    </div>
  );
}

export default function PdfPreview({ filePath }: { filePath: string }) {
  const { t } = useI18n();
  const viewportRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
  const [numPages, setNumPages] = useState(0);
  const initialReadingState = readingState.get(filePath);
  const [currentPage, setCurrentPage] = useState(initialReadingState?.page ?? 1);
  const [scale, setScale] = useState(initialReadingState?.scale ?? 1);
  const [rotation, setRotation] = useState(initialReadingState?.rotation ?? 0);
  const [fitWidth, setFitWidth] = useState(initialReadingState?.fitWidth ?? true);
  const [viewportWidth, setViewportWidth] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const saved = readingState.get(filePath);
      setError(null);
      setPdfData(null);
      setCurrentPage(saved?.page ?? 1);
      setScale(saved?.scale ?? 1);
      setRotation(saved?.rotation ?? 0);
      setFitWidth(saved?.fitWidth ?? true);
      setNumPages(0);
      try {
        const data = await readFile(filePath);
        if (cancelled) return;
        setPdfData(data);
      } catch (err) {
        if (cancelled) return;
        console.error('[PdfPreview] Failed to read:', err);
        setError(err instanceof Error ? err.message : String(err));
      }
    };

    load();
    return () => { cancelled = true; };
  }, [filePath]);

  useEffect(() => {
    readingState.set(filePath, { page: currentPage, scale, rotation, fitWidth });
  }, [currentPage, filePath, fitWidth, rotation, scale]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () => setViewportWidth(viewport.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const loading = !pdfData && !error;

  // Memoize the file object so react-pdf loads the document ONCE. A fresh
  // `{ data }` object each render makes react-pdf reload, and pdf.js transfers
  // the buffer to the worker on load (detaching `pdfData`) — the reload then
  // tries to post the detached array and throws "The object can not be cloned".
  const fileProp = useMemo(() => (pdfData ? { data: pdfData } : null), [pdfData]);

  const onDocumentLoadSuccess = ({ numPages: n }: { numPages: number }) => {
    setNumPages(n);
    setCurrentPage((page) => Math.min(Math.max(1, page), n));
  };

  const onDocumentLoadError = (err: Error) => {
    console.error('[PdfPreview] PDF load error:', err);
    setError(err.message);
  };

  if (error) {
    return (
      <div className="flex items-center justify-center h-full p-4">
        <p className="text-body text-[var(--abu-danger)]">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Reading controls — grouped by task: navigation on the left, view on the right. */}
      {numPages > 0 && (
        <div className="shrink-0 flex items-center justify-between gap-3 px-3 py-1.5 bg-[var(--abu-bg-subtle)] border-b border-[var(--abu-border-subtle)]">
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage <= 1}
              title={t.panel.pdfPrevPage}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <span className="text-caption tabular-nums text-[var(--abu-text-tertiary)] min-w-[84px] text-center">
              {format(t.panel.pdfPage, { current: String(currentPage), total: String(numPages) })}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setCurrentPage(p => Math.min(numPages, p + 1))}
              disabled={currentPage >= numPages}
              title={t.panel.pdfNextPage}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="flex items-center gap-0.5 rounded-lg border border-[var(--abu-border-subtle)] bg-[var(--abu-bg-base)] p-0.5">
            <Button
              variant="ghost"
              size="icon-xs"
              className={fitWidth ? 'bg-[var(--abu-clay-bg)] text-[var(--abu-clay)]' : ''}
              onClick={() => setFitWidth((value) => !value)}
              title={t.panel.pdfFitWidth}
            >
              <ScanLine className="h-3.5 w-3.5" strokeWidth={1.6} />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setRotation((value) => nextPdfRotation(value))}
              title={t.panel.pdfRotate}
            >
              <RotateCw className="h-3.5 w-3.5" strokeWidth={1.6} />
            </Button>
            <div className="mx-0.5 h-4 w-px bg-[var(--abu-border-subtle)]" />
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => { setFitWidth(false); setScale((value) => clampPdfScale(value - 0.25)); }}
              disabled={!fitWidth && scale <= PDF_SCALE_MIN}
              title={t.panel.pdfZoomOut}
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </Button>
            <span className="text-caption tabular-nums text-[var(--abu-text-tertiary)] min-w-[46px] text-center">
              {fitWidth ? t.panel.pdfFit : `${Math.round(scale * 100)}%`}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => { setFitWidth(false); setScale((value) => clampPdfScale(value + 0.25)); }}
              disabled={!fitWidth && scale >= PDF_SCALE_MAX}
              title={t.panel.pdfZoomIn}
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      {/* PDF Content */}
      <div ref={viewportRef} className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          <div className="flex min-h-full justify-center bg-[var(--abu-bg-active)] p-6">
            {loading && (
              <LoadingIndicator label={t.panel.loadingDocument} />
            )}
            {fileProp && (
              <Document
                file={fileProp}
                onLoadSuccess={onDocumentLoadSuccess}
                onLoadError={onDocumentLoadError}
                loading={<LoadingIndicator label={t.panel.loadingDocument} />}
              >
                <Page
                  pageNumber={currentPage}
                  width={fitWidth && viewportWidth > 0 ? Math.max(240, viewportWidth - 48) : undefined}
                  scale={fitWidth ? undefined : scale}
                  rotate={rotation}
                  className="overflow-hidden rounded-sm shadow-[0_18px_50px_rgba(35,31,23,0.16)]"
                  loading={<div className="h-[400px]"><LoadingIndicator /></div>}
                />
              </Document>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
