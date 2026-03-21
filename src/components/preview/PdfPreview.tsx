import { useEffect, useState } from 'react';
import { readFile } from '@tauri-apps/plugin-fs';
import { Document, Page, pdfjs } from 'react-pdf';
import { useI18n } from '@/i18n';
import { format } from '@/i18n';
import { Loader2, ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';

import 'react-pdf/dist/Page/TextLayer.css';
import 'react-pdf/dist/Page/AnnotationLayer.css';

pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

function LoadingIndicator({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 h-full">
      <Loader2 className="w-5 h-5 text-[var(--abu-clay)] animate-spin" />
      {label && <span className="text-[13px] text-[var(--abu-text-tertiary)]">{label}</span>}
    </div>
  );
}

export default function PdfPreview({ filePath }: { filePath: string }) {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [scale, setScale] = useState(1.0);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setError(null);
      setPdfData(null);
      setCurrentPage(1);
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

  const loading = !pdfData && !error;

  const onDocumentLoadSuccess = ({ numPages: n }: { numPages: number }) => {
    setNumPages(n);
  };

  const onDocumentLoadError = (err: Error) => {
    console.error('[PdfPreview] PDF load error:', err);
    setError(err.message);
  };

  if (error) {
    return (
      <div className="flex items-center justify-center h-full p-4">
        <p className="text-[13px] text-red-500">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Controls */}
      {numPages > 0 && (
        <div className="shrink-0 flex items-center justify-between px-3 py-1.5 bg-[var(--abu-bg-muted)] border-b border-[var(--abu-bg-pressed)]">
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
            <span className="text-[11px] text-[var(--abu-text-tertiary)] min-w-[80px] text-center">
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
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setScale(s => Math.max(0.5, s - 0.25))}
              disabled={scale <= 0.5}
              title={t.panel.pdfZoomOut}
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </Button>
            <span className="text-[11px] text-[var(--abu-text-tertiary)] min-w-[40px] text-center">
              {Math.round(scale * 100)}%
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setScale(s => Math.min(3, s + 0.25))}
              disabled={scale >= 3}
              title={t.panel.pdfZoomIn}
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      {/* PDF Content */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="flex justify-center p-4 bg-[var(--abu-bg-hover)]">
          {loading && (
            <LoadingIndicator label={t.panel.loadingDocument} />
          )}
          {pdfData && (
            <Document
              file={{ data: pdfData }}
              onLoadSuccess={onDocumentLoadSuccess}
              onLoadError={onDocumentLoadError}
              loading={<LoadingIndicator label={t.panel.loadingDocument} />}
            >
              <Page
                pageNumber={currentPage}
                scale={scale}
                className="shadow-lg"
                loading={<div className="h-[400px]"><LoadingIndicator /></div>}
              />
            </Document>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
