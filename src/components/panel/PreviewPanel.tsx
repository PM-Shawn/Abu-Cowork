import { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { readTextFile, exists } from '@tauri-apps/plugin-fs';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { getBaseName, loadLocalImage } from '@/utils/pathUtils';
import { buildPreviewUrl } from '@/utils/previewUrl';
import { atomicWrite } from '@/utils/atomicFs';
import { reconcileEditorContent } from '@/utils/editorReconcile';
import { usePreviewStore } from '@/stores/previewStore';
import { usePreviewFileWatch } from '@/hooks/usePreviewFileWatch';
import { useToastStore } from '@/stores/toastStore';
import { useI18n, getI18n } from '@/i18n';
import { ScrollArea } from '@/components/ui/scroll-area';
import MarkdownRenderer from '@/components/chat/MarkdownRenderer';
import CodeMirrorEditor from './CodeMirrorEditor';
import { Loader2, X, FolderOpen, Code, Eye, Globe, FileCode, FileText, FileImage, FileSpreadsheet, FileType, File } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DocSelectionLayer } from '@/features/reference/DocSelectionLayer';

const PdfPreview = lazy(() => import('@/components/preview/PdfPreview'));
const DocxPreview = lazy(() => import('@/components/preview/DocxPreview'));
const XlsxPreview = lazy(() => import('@/components/preview/XlsxPreview'));
const CsvPreview = lazy(() => import('@/components/preview/CsvPreview'));
const PptxPreview = lazy(() => import('@/components/preview/PptxPreview'));

type RendererType = 'markdown' | 'code' | 'image' | 'text' | 'html' | 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'csv' | 'unsupported';

/** Binary types that handle their own file reading */
const BINARY_TYPES = new Set<RendererType>(['pdf', 'docx', 'pptx', 'xlsx']);

/**
 * Types that get an editable CodeMirror buffer (P2). html/markdown toggle
 * between a rendered preview and this editable source view; code/text have
 * no rendered form at all, so they're always shown editable.
 */
const EDITABLE_TYPES = new Set<RendererType>(['code', 'text', 'html', 'markdown']);

function isDataUrl(path: string): boolean {
  return path.startsWith('data:');
}

function getRendererType(filePath: string): RendererType {
  if (isDataUrl(filePath) && filePath.startsWith('data:image/')) return 'image';
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  if (ext === 'md') return 'markdown';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (ext === 'pptx' || ext === 'ppt') return 'pptx';
  if (ext === 'xlsx' || ext === 'xls') return 'xlsx';
  if (ext === 'csv') return 'csv';
  if ([
    'ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'cpp', 'c', 'h',
    'json', 'yaml', 'yml', 'toml', 'xml', 'css', 'scss', 'less',
    'sh', 'bash', 'zsh', 'sql', 'graphql', 'rb', 'php', 'swift', 'kt'
  ].includes(ext)) return 'code';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'].includes(ext)) return 'image';
  if (['txt', 'log'].includes(ext)) return 'text';
  return 'unsupported';
}

/** File extension, lowercased — used to pick a CodeMirror language extension. */
function getFileExtension(filePath: string): string {
  return filePath.split('.').pop()?.toLowerCase() || '';
}

function getFileIcon(filePath: string) {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'html', 'css', 'json'].includes(ext)) return FileCode;
  if (['md', 'txt', 'log'].includes(ext)) return FileText;
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return FileImage;
  if (['xlsx', 'xls', 'csv'].includes(ext)) return FileSpreadsheet;
  if (ext === 'pdf' || ext === 'docx' || ext === 'pptx' || ext === 'ppt') return FileType;
  return File;
}

function LazyFallback() {
  return (
    <div className="flex items-center justify-center h-full">
      <Loader2 className="w-5 h-5 text-[var(--abu-clay)] animate-spin" />
    </div>
  );
}

export default function PreviewPanel() {
  const { previewFilePath, closePreview, reloadNonce } = usePreviewStore();
  usePreviewFileWatch(previewFilePath);
  const { t } = useI18n();
  const [content, setContent] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [htmlPreviewUrl, setHtmlPreviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Preview/source toggle — applies to html (iframe vs editable source) and
  // markdown (rendered vs editable source). code/text have no rendered form
  // and are always shown via the editable source view regardless of this.
  const [viewMode, setViewMode] = useState<'preview' | 'source'>('preview');

  // Editable buffer for code/text/html/markdown (P2). `draft` is what
  // CodeMirror shows and edits; it's debounce-autosaved to disk below.
  const [draft, setDraft] = useState<string>('');
  const draftRef = useRef<string>('');
  useEffect(() => { draftRef.current = draft; }, [draft]);
  // Content last known to be on disk (initial load, or our own last
  // successful autosave) — used by editorReconcile to detect unsaved edits.
  const lastSavedRef = useRef<string>('');
  // Content of our own last in-flight/successful autosave write, so a
  // reload triggered by that very write's fs-watch echo can be told apart
  // from a genuine external change. Cleared on save failure.
  const selfEchoRef = useRef<string | null>(null);
  // The file path for which `lastSavedRef`/`draft` currently hold an
  // established editable baseline. Reloads for this same path are treated
  // as "quiet" (no loading spinner / no reset) so typing isn't interrupted
  // by our own autosave's fs-watch echo.
  const establishedEditablePathRef = useRef<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirrors whatever autosave is currently scheduled (path + content). The
  // debounce effect's cleanup below uses this to flush a still-pending save
  // when its target stops being the current file (switched away, or closed)
  // instead of silently dropping it — see that cleanup for details.
  const pendingSaveRef = useRef<{ path: string; content: string } | null>(null);

  const rendererType = previewFilePath ? getRendererType(previewFilePath) : 'unsupported';
  const fileName = previewFilePath && isDataUrl(previewFilePath) ? t.panel.imagePreview : (previewFilePath ? getBaseName(previewFilePath) : '');
  const Icon = previewFilePath ? (isDataUrl(previewFilePath) ? FileImage : getFileIcon(previewFilePath)) : File;

  useEffect(() => {
    if (!previewFilePath) {
      setContent(null);
      setImageUrl(null);
      setHtmlPreviewUrl(null);
      setDraft('');
      lastSavedRef.current = '';
      selfEchoRef.current = null;
      establishedEditablePathRef.current = null;
      return;
    }

    let cancelled = false;
    let blobUrl: string | null = null;
    const isEditableType = EDITABLE_TYPES.has(rendererType);
    // A reload (reloadNonce bump) of a file we've already established an
    // editable baseline for — most commonly our own autosave's fs-watch
    // echo. Skip the full loading/reset cycle so the editor never flashes
    // a spinner or drops focus while the user is typing.
    const isQuietReload = isEditableType && establishedEditablePathRef.current === previewFilePath;

    const loadFile = async () => {
      if (!isQuietReload) {
        setLoading(true);
        setError(null);
        setContent(null);
        setImageUrl(null);
        setHtmlPreviewUrl(null);
        setDraft('');
        lastSavedRef.current = '';
        selfEchoRef.current = null;
        establishedEditablePathRef.current = null;
      }

      try {
        // Binary types and unsupported types don't need text reading from parent
        if (rendererType === 'unsupported' || BINARY_TYPES.has(rendererType)) {
          setLoading(false);
          return;
        }

        // Data URL: use directly
        if (isDataUrl(previewFilePath)) {
          setImageUrl(previewFilePath);
          setLoading(false);
          return;
        }

        // Check if file exists before attempting to read
        const fileExists = await exists(previewFilePath);
        if (cancelled) return;
        if (!fileExists) {
          setError(`${t.panel.fileNotFound}: ${getBaseName(previewFilePath)}`);
          setLoading(false);
          return;
        }

        if (rendererType === 'image') {
          blobUrl = await loadLocalImage(previewFilePath);
          if (cancelled) { URL.revokeObjectURL(blobUrl); blobUrl = null; return; }
          setImageUrl(blobUrl);
        } else {
          // HTML and text-like types: read the source for the source-mode toggle.
          // HTML preview mode also needs an iframe URL from the loopback server;
          // fetched in parallel so both modes are ready when the user toggles.
          const text = await readTextFile(previewFilePath);
          if (cancelled) return;
          setContent(text);

          if (rendererType === 'html' && !isQuietReload) {
            const url = await buildPreviewUrl(previewFilePath);
            if (cancelled) return;
            setHtmlPreviewUrl(url);
          }

          if (isEditableType) {
            if (!isQuietReload) {
              // Fresh load of this file: disk content becomes both the
              // editor buffer and the reconcile baseline.
              lastSavedRef.current = text;
              setDraft(text);
              establishedEditablePathRef.current = previewFilePath;
            } else {
              // Reload of a file we're already editing — reconcile instead
              // of blindly overwriting the user's in-progress draft.
              const isSelfEcho = selfEchoRef.current !== null && text === selfEchoRef.current;
              const result = reconcileEditorContent({
                diskContent: text,
                draft: draftRef.current,
                lastSaved: lastSavedRef.current,
                isSelfEcho,
              });
              if (result.nextDraft !== draftRef.current) setDraft(result.nextDraft);
              // Self-echoes don't move the baseline forward — it was already
              // set (to this same content) at save time.
              if (!isSelfEcho) lastSavedRef.current = text;
              if (result.conflict) {
                useToastStore.getState().addToast({
                  type: 'warning',
                  title: t.panel.externalChangeTitle,
                  message: t.panel.externalChangeMessage,
                });
              }
            }
          }
        }
      } catch (err) {
        if (cancelled) return;
        // The read failed, so no editable baseline was established for this
        // attempt — the next reload for this path should go through the
        // full (non-quiet) reset rather than reconciling against stale refs.
        establishedEditablePathRef.current = null;
        console.error('[PreviewPanel] Failed to read file:', previewFilePath, err);
        const message = err instanceof Error ? err.message : String(err);
        setError(message || t.panel.failedToReadFile);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadFile();
    return () => { cancelled = true; if (blobUrl) URL.revokeObjectURL(blobUrl); };
  // reloadNonce is a fs-watch/manual refresh signal: re-run to re-read content
  // (and, for images, re-fetch the blob) when the file changes on disk.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t is stable from i18n singleton
  }, [previewFilePath, rendererType, reloadNonce]);

  // Debounced autosave: write the editable buffer to disk 1s after the user
  // stops typing. `selfEchoRef` is set right before the write so the fs-watch
  // reload it triggers (handled above) can recognize its own echo instead of
  // treating it as an external change and re-adopting/conflicting on it.
  useEffect(() => {
    if (!previewFilePath || !EDITABLE_TYPES.has(rendererType)) return;
    if (draft === lastSavedRef.current) return;

    const targetPath = previewFilePath;
    const contentToSave = draft;
    pendingSaveRef.current = { path: targetPath, content: contentToSave };

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      pendingSaveRef.current = null;
      selfEchoRef.current = contentToSave;
      atomicWrite(targetPath, contentToSave)
        .then(() => {
          lastSavedRef.current = contentToSave;
        })
        .catch((err) => {
          console.error('[PreviewPanel] Failed to autosave:', targetPath, err);
          // This write never landed — don't let a later disk read be
          // mistaken for its echo.
          if (selfEchoRef.current === contentToSave) selfEchoRef.current = null;
          useToastStore.getState().addToast({
            type: 'error',
            title: t.panel.saveFailedTitle,
            message: err instanceof Error ? err.message : String(err),
          });
        });
    }, 1000);

    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      // This cleanup also runs when `draft` changes again for the *same*
      // file (every keystroke) — in that ordinary case we must NOT flush,
      // or every keystroke would write to disk and defeat the debounce.
      // It also fires when switching to a different file, or on true
      // unmount (closing the preview) — in both of those the pending save's
      // target no longer matches where we're headed, so flush it instead of
      // silently dropping the edit. `usePreviewStore.getState()` (not the
      // closed-over `previewFilePath`) is used because on unmount this
      // component may never re-render with the new value before disappearing.
      const pending = pendingSaveRef.current;
      if (pending && pending.path !== usePreviewStore.getState().previewFilePath) {
        pendingSaveRef.current = null;
        atomicWrite(pending.path, pending.content).catch((err) => {
          console.error('[PreviewPanel] Failed to flush pending autosave for previous file:', pending.path, err);
          useToastStore.getState().addToast({
            type: 'error',
            title: getI18n().panel.saveFailedTitle,
            message: err instanceof Error ? err.message : String(err),
          });
        });
      }
    };
  // previewFilePath/rendererType/t are read at schedule time only; `draft`
  // changing is the sole intended trigger (including path/type as deps would
  // cause redundant reschedules on every file switch).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const handleOpenInFinder = async () => {
    if (previewFilePath) {
      try {
        await revealItemInDir(previewFilePath);
      } catch (err) {
        console.error('Failed to open folder:', err);
      }
    }
  };

  const handleOpenInBrowser = async () => {
    if (!previewFilePath) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const platform = navigator.platform.toLowerCase();
      const command = platform.includes('win')
        ? `start "" "${previewFilePath}"`
        : platform.includes('linux')
          ? `xdg-open "${previewFilePath}"`
          : `open "${previewFilePath}"`;
      await invoke('run_shell_command', {
        command,
        cwd: null,
        background: true,
        timeout: 5,
        sandboxEnabled: false,
      });
    } catch (err) {
      console.error('[PreviewPanel] Failed to open in browser:', err);
    }
  };

  if (!previewFilePath) return null;

  return (
    <div className="flex flex-col h-full">
      {/* Header — mt-7 to clear the overlay title bar drag region */}
      <div className="shrink-0 px-3 py-2.5 mt-7 border-b border-[var(--abu-bg-pressed)] flex items-center gap-2">
        <Icon className="w-4 h-4 text-[var(--abu-text-tertiary)] shrink-0" />
        <span className="text-[13px] font-medium text-[var(--abu-text-primary)] truncate flex-1">
          {fileName}
        </span>
        {(rendererType === 'html' || rendererType === 'markdown') && (
          <div className="flex items-center bg-[var(--abu-bg-hover)] rounded p-0.5 mr-1">
            <button
              onClick={() => setViewMode('preview')}
              className={`p-1 rounded text-[10px] ${viewMode === 'preview' ? 'bg-white' : ''}`}
              title={t.panel.previewMode}
            >
              <Eye className="w-3 h-3" />
            </button>
            <button
              onClick={() => setViewMode('source')}
              className={`p-1 rounded text-[10px] ${viewMode === 'source' ? 'bg-white' : ''}`}
              title={t.panel.sourceMode}
            >
              <Code className="w-3 h-3" />
            </button>
          </div>
        )}
        {rendererType === 'html' && (
          <Button
            variant="ghost"
            size="icon"
            onClick={handleOpenInBrowser}
            className="h-6 w-6 text-[var(--abu-text-tertiary)] hover:text-[var(--abu-clay)]"
            title={t.chat.openInBrowser}
          >
            <Globe className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={closePreview}
          className="h-6 w-6 text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)]"
          title={t.panel.closePreview}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-5 h-5 text-[var(--abu-clay)] animate-spin" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-full p-4 text-center">
            <p className="text-[13px] text-red-500">{error}</p>
          </div>
        ) : rendererType === 'pdf' || rendererType === 'docx' || rendererType === 'pptx' || rendererType === 'xlsx' || (rendererType === 'csv' && content !== null) ? (
          <Suspense fallback={<LazyFallback />}>
            {rendererType === 'pdf' && <PdfPreview filePath={previewFilePath} />}
            {rendererType === 'docx' && <DocxPreview filePath={previewFilePath} />}
            {rendererType === 'pptx' && <PptxPreview filePath={previewFilePath} />}
            {rendererType === 'xlsx' && <XlsxPreview filePath={previewFilePath} />}
            {rendererType === 'csv' && content !== null && <CsvPreview content={content} />}
          </Suspense>
        ) : rendererType === 'image' && imageUrl ? (
          <div className="flex items-center justify-center h-full p-4 bg-[var(--abu-bg-active)]">
            <img src={imageUrl} alt={fileName} className="max-w-full max-h-full object-contain" />
          </div>
        ) : rendererType === 'markdown' && content !== null ? (
          viewMode === 'preview' ? (
            <ScrollArea className="h-full">
              <DocSelectionLayer filePath={previewFilePath}>
                <div className="p-4">
                  <MarkdownRenderer content={content} />
                </div>
              </DocSelectionLayer>
            </ScrollArea>
          ) : (
            <CodeMirrorEditor value={draft} language="md" onChange={setDraft} />
          )
        ) : rendererType === 'html' ? (
          viewMode === 'preview' ? (
            htmlPreviewUrl ? (
              <iframe
                // Query-string nonce (not a `key` remount) forces the iframe to
                // re-navigate on refresh: axum's Path extractor only matches the
                // path portion of the URL (see src-tauri/src/preview_server.rs
                // `serve_file`'s `axum::extract::Path<(token, root_id, rel_path)>`
                // — rel_path is the wildcard `*rel_path` segment, which never
                // includes a query string), so `?v=` is inert server-side while
                // still changing the `src` string enough for the webview to reload.
                src={`${htmlPreviewUrl}?v=${reloadNonce}`}
                title={fileName}
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                className="w-full h-full border-0 bg-white"
              />
            ) : (
              <LazyFallback />
            )
          ) : content !== null ? (
            <CodeMirrorEditor value={draft} language="html" onChange={setDraft} />
          ) : (
            <LazyFallback />
          )
        ) : rendererType === 'code' && content !== null ? (
          <CodeMirrorEditor value={draft} language={getFileExtension(previewFilePath)} onChange={setDraft} />
        ) : rendererType === 'text' && content !== null ? (
          <CodeMirrorEditor value={draft} language={getFileExtension(previewFilePath)} onChange={setDraft} />
        ) : (
          <div className="flex flex-col items-center justify-center h-full p-4 text-center">
            <p className="text-[13px] text-[var(--abu-text-tertiary)]">{t.panel.unsupportedFileType}</p>
            <Button variant="outline" size="sm" onClick={handleOpenInFinder} className="mt-3">
              <FolderOpen className="w-3.5 h-3.5 mr-1.5" />
              {t.panel.showInFinder}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
