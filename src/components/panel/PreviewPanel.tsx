import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { readTextFile, exists } from '@tauri-apps/plugin-fs';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { getBaseName, loadLocalImage } from '@/utils/pathUtils';
import { buildPreviewUrl } from '@/utils/previewUrl';
import { atomicWrite } from '@/utils/atomicFs';
import { reconcileEditorContent } from '@/utils/editorReconcile';
import { snapshotVersion, revertToVersion } from '@/utils/canvasVersions';
import { usePreviewStore } from '@/stores/previewStore';
import { usePreviewFileWatch } from '@/hooks/usePreviewFileWatch';
import { useToastStore } from '@/stores/toastStore';
import { useChatStore } from '@/stores/chatStore';
import { useI18n, getI18n } from '@/i18n';
import { ScrollArea } from '@/components/ui/scroll-area';
import MarkdownRenderer from '@/components/chat/MarkdownRenderer';
import CodeMirrorEditor from './CodeMirrorEditor';
import { VersionHistoryMenu } from './VersionHistoryMenu';
import { Loader2, X, FolderOpen, Code, Eye, SquareArrowOutUpRight, History, FileCode, FileText, FileImage, FileSpreadsheet, FileType, File, Maximize2, Minimize2, RotateCw, Globe, SquareDashedMousePointer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DocSelectionLayer } from '@/features/reference/DocSelectionLayer';
import { cn } from '@/lib/utils';
import { isMacOS } from '@/utils/platform';
import { getToolbarButtons } from './previewToolbarConfig';
import { openWithDefaultApp } from '@/utils/openWithDefaultApp';
import { createDomElementReference, type BrowserElementPayload } from '@/types/chatReference';
import { isValidInspectSelection } from '@/utils/inspectMessage';

const PdfPreview = lazy(() => import('@/components/preview/PdfPreview'));
const DocxPreview = lazy(() => import('@/components/preview/DocxPreview'));
const XlsxPreview = lazy(() => import('@/components/preview/XlsxPreview'));
const CsvPreview = lazy(() => import('@/components/preview/CsvPreview'));
const PptxPreview = lazy(() => import('@/components/preview/PptxPreview'));

export type RendererType = 'markdown' | 'code' | 'image' | 'text' | 'html' | 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'csv' | 'unsupported';

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

/**
 * CSS custom-property values the injected preview-page inspect script needs
 * to replicate `SelectionToolbar`/`CommentEditor` styling. The injected
 * script runs inside the loopback iframe with no access to Abu's Tailwind
 * config or `:root` tokens, so the host resolves them here (same pattern as
 * TRAE's `getThemeColors` bridge, and identical to `BrowserTab.tsx`'s
 * `resolveInspectTheme` — ported inline here since that component isn't in
 * `dev` yet) and passes them down alongside `labels`. The picker script
 * falls back to its own light-theme literals if this is ever absent/malformed.
 */
function resolveInspectTheme() {
  const cs = getComputedStyle(document.documentElement);
  const read = (name: string) => cs.getPropertyValue(name).trim();
  return {
    bgBase: read('--abu-bg-base'),
    bgHover: read('--abu-bg-hover'),
    borderSubtle: read('--abu-border-subtle'),
    textPrimary: read('--abu-text-primary'),
    textTertiary: read('--abu-text-tertiary'),
    danger: read('--abu-danger'),
  };
}

function LazyFallback() {
  return (
    <div className="flex items-center justify-center h-full">
      <Loader2 className="w-5 h-5 text-[var(--abu-clay)] animate-spin" />
    </div>
  );
}

export default function PreviewPanel({
  filePath: filePathProp,
  tabId,
  embedded = false,
}: { filePath?: string; tabId?: string; embedded?: boolean } = {}) {
  // Back-compat: without a `filePath` prop (older call sites, before
  // workspace tabs existed), fall back to the store's single previewFilePath.
  const storePreviewFilePath = usePreviewStore((s) => s.previewFilePath);
  const closePreview = usePreviewStore((s) => s.closePreview);
  const closeTab = usePreviewStore((s) => s.closeTab);
  // "Select element" inspect mode (multi-tab keep-alive, see workspace tabs
  // design) needs to know which tab is actually visible right now — a
  // hidden background tab must never stay armed.
  const activeTabId = usePreviewStore((s) => s.activeTabId);
  const previewFilePath = filePathProp ?? storePreviewFilePath;
  // Each instance owns its own reload nonce (keep-alive multi-tab preview —
  // see docs/2026-07-17-workspace-tabs-design.md) instead of reading a
  // single global one off the store.
  const [reloadNonce, setReloadNonce] = useState(0);
  usePreviewFileWatch(previewFilePath, () => setReloadNonce((n) => n + 1));
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
  // Version history (P4) dropdown — trigger button + panel share this ref
  // for outside-click detection (see ModelSelector's modelPickerRef for the
  // same pattern).
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const versionHistoryRef = useRef<HTMLDivElement>(null);
  // App-fullscreen toggle (Task 6) — expands the panel to a fixed overlay
  // covering the whole window instead of just its column in RightPanel.
  const [isFullscreen, setIsFullscreen] = useState(false);

  // "Select element" inspect mode (see docs/2026-07-19-preview-element-select-design.md).
  // The iframe is cross-origin (loopback http://127.0.0.1 vs the app shell),
  // so a ref is needed to reach its contentWindow for postMessage.
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [inspecting, setInspecting] = useState(false);
  // Nonce minted each time inspect mode is armed — anti-replay/anti-cross-talk
  // for the postMessage channel, not a secret (any script sharing the iframe's
  // window can read it). Cleared to null on disarm.
  const inspectNonceRef = useRef<string | null>(null);
  // Gates the toggle button until the iframe has actually navigated once —
  // toggling before `onLoad` would postMessage into a still-blank/previous doc.
  const [iframeLoaded, setIframeLoaded] = useState(false);

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
  const toolbarButtons = getToolbarButtons(rendererType);

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
              // Version history (P4) baseline: snapshot the pre-edit original
              // so it's always recoverable, even before the user's first edit
              // autosaves. Fire-and-forget — a history-write failure must
              // never block the editor from loading. snapshotVersion's own
              // dedupe means re-opening an already-snapshotted file is a no-op.
              snapshotVersion(previewFilePath, text).catch((err) => {
                console.warn('[PreviewPanel] Failed to snapshot baseline version:', previewFilePath, err);
              });
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
              // set (to this same content) at save time. A genuine external
              // change moves the baseline AND clears any stale self-echo
              // expectation, else a later revert back to our last self-saved
              // content would be misread as an echo and shown as stale (F2).
              if (!isSelfEcho) {
                lastSavedRef.current = text;
                selfEchoRef.current = null;
              }
              if (result.conflict) {
                // The user's unsaved draft diverges from a fresh external
                // write. Cancel the still-pending autosave so it can't
                // silently clobber that external write ~1s later (F1): the
                // draft stays in the editor (nothing lost) and the toast
                // informs the user. Further typing reschedules a save, which
                // is then the user's explicit choice to overwrite.
                if (saveTimerRef.current) {
                  clearTimeout(saveTimerRef.current);
                  saveTimerRef.current = null;
                }
                pendingSaveRef.current = null;
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

  // Reset to rendered-preview mode on each file switch so a document never
  // inherits the previously-viewed file's source/edit mode (F4). Keyed on
  // previewFilePath only — a same-file watch reload (reloadNonce) must not
  // flip the user out of source mode while they're editing.
  useEffect(() => { setViewMode('preview'); }, [previewFilePath]);

  // Close the version history dropdown on file switch — it's scoped to
  // whatever file was previously open, not the newly selected one.
  useEffect(() => { setShowVersionHistory(false); }, [previewFilePath]);

  // Esc exits app-fullscreen — only listen while fullscreen is active.
  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setIsFullscreen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isFullscreen]);

  // Disarm inspect mode: tell the page-side picker to go idle and clear the
  // nonce. Safe to call when already disarmed (no-op postMessage) — every
  // call site below (toggle-off, resets, successful pick) just calls this
  // rather than tracking whether it's already off.
  const disableInspect = useCallback(() => {
    setInspecting(false);
    inspectNonceRef.current = null;
    if (!htmlPreviewUrl) return;
    try {
      const targetOrigin = new URL(htmlPreviewUrl).origin;
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'abu-preview-inspect:set-enabled', enabled: false, nonce: null, labels: null },
        targetOrigin,
      );
    } catch (err) {
      console.warn('[PreviewPanel] Failed to disarm inspect mode:', err);
    }
  }, [htmlPreviewUrl]);

  // Arm/disarm inspect mode. Mints a fresh nonce on arm (anti-replay/anti-
  // cross-talk — see disableInspect's comment) and ships the labels/theme
  // the page-side picker needs since it has no i18n or CSS token access of
  // its own (same bridge pattern as the browser tab's picker).
  const toggleInspect = useCallback(() => {
    if (!iframeRef.current || !htmlPreviewUrl) return;
    if (inspecting) {
      disableInspect();
      return;
    }
    const nonce = Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
    try {
      const targetOrigin = new URL(htmlPreviewUrl).origin;
      inspectNonceRef.current = nonce;
      setInspecting(true);
      iframeRef.current.contentWindow?.postMessage(
        {
          type: 'abu-preview-inspect:set-enabled',
          enabled: true,
          nonce,
          labels: {
            addToChat: t.reference.addToChat,
            commentToChat: t.reference.commentToChat,
            commentPlaceholder: t.reference.commentPlaceholder,
            cancel: t.common.cancel,
            shortcutModifier: isMacOS() ? '⌘' : 'Ctrl',
            theme: resolveInspectTheme(),
          },
        },
        targetOrigin,
      );
    } catch (err) {
      console.warn('[PreviewPanel] Failed to arm inspect mode:', err);
      setInspecting(false);
      inspectNonceRef.current = null;
    }
  }, [inspecting, htmlPreviewUrl, disableInspect, t]);

  // Listen for the picker's pick reply. Every gate (source/origin/type/nonce/
  // size) is centralized in isValidInspectSelection so it's unit-testable
  // without a real iframe — see src/utils/inspectMessage.ts.
  useEffect(() => {
    if (!htmlPreviewUrl) return;
    let expectedOrigin: string;
    try {
      expectedOrigin = new URL(htmlPreviewUrl).origin;
    } catch {
      return;
    }
    const handleMessage = (e: MessageEvent) => {
      const valid = isValidInspectSelection({
        source: e.source,
        origin: e.origin,
        data: e.data,
        expectedOrigin,
        expectedSource: iframeRef.current?.contentWindow ?? null,
        expectedNonce: inspectNonceRef.current,
      });
      if (!valid) return;
      const payload = (e.data as { payload: BrowserElementPayload }).payload;
      useChatStore.getState().addPendingReference(createDomElementReference(payload));
      // Single-select: exit inspect mode after one pick.
      disableInspect();
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [htmlPreviewUrl, disableInspect]);

  // Disarm on file switch / manual reload — a fresh document has a fresh
  // (idle-by-default) picker instance, so any previously-armed state is stale.
  useEffect(() => {
    setIframeLoaded(false);
    disableInspect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- disableInspect intentionally omitted: it depends on htmlPreviewUrl, which changes as a *result* of a file switch (after the async load completes), not the trigger; keying on it here would double-fire
  }, [previewFilePath, reloadNonce]);

  // Disarm when the surface backing inspect mode stops being visible: leaving
  // preview for source view (no rendered DOM to pick from), or — for
  // keep-alive multi-tab preview — this instance's tab is no longer the
  // active one (a hidden background tab must never stay armed).
  useEffect(() => {
    if (!inspecting) return;
    if (viewMode === 'source' || (embedded && tabId !== undefined && activeTabId !== tabId)) {
      disableInspect();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- disableInspect intentionally omitted (see above)
  }, [inspecting, viewMode, activeTabId, embedded, tabId]);

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
          // Version history (P4): keep a full-content snapshot of every
          // autosaved revision. Fire-and-forget — a history-write failure
          // must never surface as a save failure (the actual save already
          // succeeded above).
          snapshotVersion(targetPath, contentToSave).catch((snapErr) => {
            console.warn('[PreviewPanel] Failed to snapshot version after autosave:', targetPath, snapErr);
          });
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

  // Authoritative revert: write the snapshot to disk AND adopt it into the
  // editor buffer directly. A revert is an explicit user action, so it must
  // override any unsaved draft — otherwise the fs-watch reload would hit the
  // reconcile "conflict" branch (disk != draft, draft != lastSaved), keep the
  // draft, and the revert would silently do nothing on screen while the file
  // on disk diverged. Cancelling the pending autosave also stops it from
  // clobbering the just-reverted file (R1/R2). selfEchoRef makes the revert
  // write's own fs-watch echo recognizable as self, not an external change.
  const handleRevertVersion = async (id: string) => {
    if (!previewFilePath) return;
    const content = await revertToVersion(previewFilePath, id);
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    pendingSaveRef.current = null;
    selfEchoRef.current = content;
    lastSavedRef.current = content;
    setDraft(content);
  };

  const handleOpenInFinder = async () => {
    if (previewFilePath) {
      try {
        await revealItemInDir(previewFilePath);
      } catch (err) {
        console.error('Failed to open folder:', err);
      }
    }
  };

  const handleOpenInApp = async () => {
    if (!previewFilePath) return;
    try {
      await openWithDefaultApp(previewFilePath);
    } catch (err) {
      console.error('[PreviewPanel] open in app failed:', err);
      useToastStore.getState().addToast({
        type: 'error',
        title: t.chat.openFailed,
        message: t.panel.openInAppFailed,
      });
    }
  };

  if (!previewFilePath) return null;

  return (
    <div className={cn(
      'flex flex-col',
      isFullscreen ? 'fixed inset-0 z-50 bg-[var(--abu-bg-base)]' : 'h-full',
    )}>
      {/* Header — flush at the top (the floating card + tab strip clear the title
          bar). In fullscreen the overlay is inset-0, so pad left to clear the
          macOS traffic lights. */}
      <div className={cn(
        'shrink-0 px-3 py-2.5 border-b border-[var(--abu-bg-pressed)] flex items-center gap-2',
        isFullscreen && isMacOS() && 'pl-20',
      )}>
        {/* Filename shown only when NOT embedded in a tab (the tab strip already
            shows it — avoid a duplicate title), except in fullscreen where the
            tab strip is covered so the title is needed again. Otherwise an empty
            spacer keeps the toolbar right-aligned. */}
        {!embedded || isFullscreen ? (
          <>
            <Icon className="w-4 h-4 text-[var(--abu-text-tertiary)] shrink-0" />
            <span className="text-body font-medium text-[var(--abu-text-primary)] truncate flex-1">
              {fileName}
            </span>
          </>
        ) : (
          <div className="flex-1" />
        )}
        {toolbarButtons.viewToggle && (
          <div className="flex items-center bg-[var(--abu-bg-hover)] rounded p-0.5 mr-1">
            <button
              onClick={() => setViewMode('source')}
              className={`p-1 rounded text-caption ${viewMode === 'source' ? 'bg-white' : ''}`}
              title={t.panel.sourceMode}
            >
              <Code className="w-3 h-3" strokeWidth={1.5} />
            </button>
            <button
              onClick={() => setViewMode('preview')}
              className={`p-1 rounded text-caption ${viewMode === 'preview' ? 'bg-white' : ''}`}
              title={t.panel.previewMode}
            >
              <Eye className="w-3 h-3" strokeWidth={1.5} />
            </button>
          </div>
        )}
        {toolbarButtons.versionHistory && (
          <div className="relative" ref={versionHistoryRef}>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setShowVersionHistory((v) => !v)}
              className="h-6 w-6 text-[var(--abu-text-tertiary)] hover:text-[var(--abu-clay)]"
              title={t.panel.versionHistory}
            >
              <History className="h-3.5 w-3.5" strokeWidth={1.5} />
            </Button>
            <VersionHistoryMenu
              filePath={previewFilePath}
              open={showVersionHistory}
              onClose={() => setShowVersionHistory(false)}
              anchorRef={versionHistoryRef}
              onRevert={handleRevertVersion}
            />
          </div>
        )}
        {toolbarButtons.openInApp && (
          <Button
            variant="ghost"
            size="icon"
            onClick={handleOpenInApp}
            className="h-6 w-6 text-[var(--abu-text-tertiary)] hover:text-[var(--abu-clay)]"
            title={t.panel.openInApp}
          >
            <SquareArrowOutUpRight className="h-3.5 w-3.5" strokeWidth={1.5} />
          </Button>
        )}
        {toolbarButtons.fullscreen && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setIsFullscreen((v) => !v)}
            className="h-6 w-6 text-[var(--abu-text-tertiary)] hover:text-[var(--abu-clay)]"
            title={isFullscreen ? t.panel.exitFullscreen : t.panel.fullscreen}
          >
            {isFullscreen ? <Minimize2 className="h-3.5 w-3.5" strokeWidth={1.5} /> : <Maximize2 className="h-3.5 w-3.5" strokeWidth={1.5} />}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => (tabId ? closeTab(tabId) : closePreview())}
          className="h-6 w-6 text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)]"
          title={t.panel.closePreview}
        >
          <X className="h-3.5 w-3.5" strokeWidth={1.5} />
        </Button>
      </div>

      {/* Browser-style address bar for HTML preview (TRAE-like): reload + the
          file path, so an HTML file reads as "opened in a browser". Real
          back/forward + a CDP console panel are Electron-only (the loopback
          iframe is cross-origin, so its navigation history isn't observable) —
          documented as out of scope; use the browser tab for free navigation. */}
      {rendererType === 'html' && viewMode === 'preview' && (
        <div className="shrink-0 flex items-center gap-1.5 px-2 py-1.5 border-b border-[var(--abu-bg-pressed)] bg-[var(--abu-bg-subtle)]">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => setReloadNonce((n) => n + 1)}
            className="text-[var(--abu-text-tertiary)] hover:text-[var(--abu-clay)]"
            title={t.panel.reloadPreview}
          >
            <RotateCw className="w-3.5 h-3.5" strokeWidth={1.5} />
          </Button>
          <div className="flex-1 min-w-0 flex items-center gap-1.5 h-6 px-2 rounded-md bg-[var(--abu-bg-base)] border border-[var(--abu-bg-pressed)]">
            <Globe className="w-3 h-3 text-[var(--abu-text-tertiary)] shrink-0" strokeWidth={1.5} />
            <span className="truncate text-caption text-[var(--abu-text-secondary)]">{previewFilePath}</span>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={!iframeLoaded}
            onClick={toggleInspect}
            className={cn(inspecting ? 'text-[var(--abu-clay)] bg-[var(--abu-clay-bg)]' : 'text-[var(--abu-text-tertiary)] hover:text-[var(--abu-clay)]')}
            title={t.panel.selectElement}
          >
            <SquareDashedMousePointer className="w-3.5 h-3.5" strokeWidth={1.5} />
          </Button>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-5 h-5 text-[var(--abu-clay)] animate-spin" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-full p-4 text-center">
            <p className="text-body text-[var(--abu-danger)]">{error}</p>
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
                  {/* Render the live draft (kept in sync with disk on load /
                      reconcile) so toggling to preview mid-edit reflects the
                      user's just-typed changes immediately, not only after the
                      ~1s autosave+watch round-trip (F5). */}
                  <MarkdownRenderer content={draft} />
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
                ref={iframeRef}
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
                onLoad={() => setIframeLoaded(true)}
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
            <p className="text-body text-[var(--abu-text-tertiary)]">{t.panel.unsupportedFileType}</p>
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
