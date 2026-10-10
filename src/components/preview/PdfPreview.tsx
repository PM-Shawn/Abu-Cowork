import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { useI18n } from '@/i18n';
import { format } from '@/i18n';
import { redactFailureText } from '@/core/diagnostic/scrub';
import { IconButton } from '@/components/ds/button';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { ScrollArea } from '@/components/ds/scroll-area';
import { Spinner } from '@/components/ds/spinner';
import { isPdfPasswordError, type PreviewFailure } from './passwordProtected';
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

// The preview asks for no password. pdf.js takes an error thrown here as the answer that
// none is given and fails the load with its `PasswordException`.
function declinePassword(): never {
  throw new Error('The preview does not ask for a password');
}

function LoadingIndicator() {
  const { t } = useI18n();
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner label={t.panel.loadingDocument} />
    </div>
  );
}

// Dragging the panel edge re-renders the preview for every width it passes through. The
// toolbar mounts a tooltip per button, so it takes only primitives and stable handlers.
const PdfToolbar = memo(function PdfToolbar({ currentPage, numPages, scale, fitWidth, onPage, onToggleFit, onRotate, onZoom }: {
  currentPage: number;
  numPages: number;
  scale: number;
  fitWidth: boolean;
  onPage: (step: -1 | 1) => void;
  onToggleFit: () => void;
  onRotate: () => void;
  onZoom: (step: -1 | 1) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-separator px-3 py-1">
      <div className="flex items-center gap-1">
        <IconButton size="sm" icon={AppIcons.previous} label={t.panel.pdfPrevPage} onClick={() => onPage(-1)} disabled={currentPage <= 1} />
        <span className="min-w-21 text-center text-caption tabular-nums text-label-tertiary">
          {format(t.panel.pdfPage, { current: String(currentPage), total: String(numPages) })}
        </span>
        <IconButton size="sm" icon={AppIcons.next} label={t.panel.pdfNextPage} onClick={() => onPage(1)} disabled={currentPage >= numPages} />
      </div>
      <div className="flex items-center gap-1 rounded-control bg-fill p-0.5">
        <IconButton size="sm" icon={AppIcons.fitWidth} label={t.panel.pdfFitWidth} aria-pressed={fitWidth} onClick={onToggleFit} />
        <IconButton size="sm" icon={AppIcons.rotateRight} label={t.panel.pdfRotate} onClick={onRotate} />
        <div className="mx-1 h-4 w-px bg-separator" />
        <IconButton size="sm" icon={AppIcons.zoomOut} label={t.panel.pdfZoomOut} onClick={() => onZoom(-1)} disabled={!fitWidth && scale <= PDF_SCALE_MIN} />
        <span className="min-w-12 text-center text-caption tabular-nums text-label-tertiary">
          {fitWidth ? t.panel.pdfFit : `${Math.round(scale * 100)}%`}
        </span>
        <IconButton size="sm" icon={AppIcons.zoomIn} label={t.panel.pdfZoomIn} onClick={() => onZoom(1)} disabled={!fitWidth && scale >= PDF_SCALE_MAX} />
      </div>
    </div>
  );
});

/**
 * Draws the bytes of a PDF. `filePath` keys the reading position; a new `data`
 * for the same path is the same file read again and keeps that position.
 */
export default function PdfPreview({ filePath, data }: { filePath: string; data: Uint8Array<ArrayBuffer> }) {
  const { t } = useI18n();
  const viewportRef = useRef<HTMLDivElement>(null);
  // The bytes pdf.js could not open; an error belongs to those bytes only.
  const [failure, setFailure] = useState<{ data: Uint8Array<ArrayBuffer>; reason: PreviewFailure } | null>(null);
  const [numPages, setNumPages] = useState(0);
  const initialReadingState = readingState.get(filePath);
  const [currentPage, setCurrentPage] = useState(initialReadingState?.page ?? 1);
  const [scale, setScale] = useState(initialReadingState?.scale ?? 1);
  const [rotation, setRotation] = useState(initialReadingState?.rotation ?? 0);
  const [fitWidth, setFitWidth] = useState(initialReadingState?.fitWidth ?? true);
  const [viewportWidth, setViewportWidth] = useState(0);

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

  // Memoize the file object so react-pdf loads each read of the file ONCE. A
  // fresh `{ data }` object each render makes react-pdf reload, and pdf.js
  // transfers the buffer to the worker on load (detaching `data`) — the reload
  // then tries to post the detached array and throws "The object can not be cloned".
  const fileProp = useMemo(() => ({ data }), [data]);

  const onDocumentLoadSuccess = ({ numPages: n }: { numPages: number }) => {
    setNumPages(n);
    setCurrentPage((page) => Math.min(Math.max(1, page), n));
  };

  const onDocumentLoadError = (err: Error) => {
    console.error('[PdfPreview] PDF load error:', redactFailureText(err.message));
    setFailure({ data, reason: isPdfPasswordError(err) ? 'password' : 'unreadable' });
  };

  const changePage = useCallback((step: -1 | 1) => {
    setCurrentPage((page) => Math.min(Math.max(1, numPages), Math.max(1, page + step)));
  }, [numPages]);

  const toggleFitWidth = useCallback(() => {
    setFitWidth((value) => !value);
  }, []);

  const rotate = useCallback(() => {
    setRotation((value) => nextPdfRotation(value));
  }, []);

  const changeZoom = useCallback((step: -1 | 1) => {
    setFitWidth(false);
    setScale((value) => clampPdfScale(value + step * 0.25));
  }, []);

  const failed = failure?.data === data;

  return (
    <div className="flex h-full flex-col">
      {/* Reading controls — grouped by task: navigation on the left, view on the right. */}
      {numPages > 0 && !failed && (
        <PdfToolbar
          currentPage={currentPage}
          numPages={numPages}
          scale={scale}
          fitWidth={fitWidth}
          onPage={changePage}
          onToggleFit={toggleFitWidth}
          onRotate={rotate}
          onZoom={changeZoom}
        />
      )}

      {/* PDF Content. The viewport stays mounted through a failure, so its width is still measured when the file is read again. */}
      <div ref={viewportRef} className="min-h-0 flex-1">
        {failed ? (
          <div className="flex h-full items-center justify-center p-4">
            <InlineMessage tone="danger">
              {failure?.reason === 'password' ? t.panel.passwordProtectedFile : t.panel.failedToReadFile}
            </InlineMessage>
          </div>
        ) : (
          <ScrollArea className="h-full">
            <div className="flex min-h-full justify-center bg-code p-6">
              <Document
                file={fileProp}
                onLoadSuccess={onDocumentLoadSuccess}
                onLoadError={onDocumentLoadError}
                onPassword={declinePassword}
                loading={<LoadingIndicator />}
              >
                {/* The page is white paper in every appearance; the marker gives its text the page selection color. */}
                <div data-page-canvas>
                  <Page
                    pageNumber={currentPage}
                    width={fitWidth && viewportWidth > 0 ? Math.max(240, viewportWidth - 48) : undefined}
                    scale={fitWidth ? undefined : scale}
                    rotate={rotation}
                    className="overflow-hidden rounded-control shadow-panel"
                    loading={<div className="h-100"><LoadingIndicator /></div>}
                  />
                </div>
              </Document>
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}
