import { memo, useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { readTextFile, exists } from '@tauri-apps/plugin-fs';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
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
import { Button, IconButton } from '@/components/ds/button';
import { EmptyState } from '@/components/ds/empty-state';
import { FullscreenSurface } from '@/components/ds/fullscreen';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { ScrollArea } from '@/components/ds/scroll-area';
import { Spinner } from '@/components/ds/spinner';
import { StatusIcon } from '@/components/ds/status-icon';
import { Tag } from '@/components/ds/tag';
import MarkdownRenderer from '@/components/chat/MarkdownRenderer';
import CodeMirrorEditor from './CodeMirrorEditor';
import { VersionHistoryMenu } from './VersionHistoryMenu';
import { DocSelectionLayer } from '@/features/reference/DocSelectionLayer';
import { cn } from '@/lib/utils';
import { isMacOS, isWindows } from '@/utils/platform';
import { getToolbarButtons } from './previewToolbarConfig';
import { openWithDefaultApp } from '@/utils/openWithDefaultApp';
import { createDomElementReference, type BrowserElementPayload } from '@/types/chatReference';
import { isValidInspectSelection, resolveReferencePath } from '@/utils/inspectMessage';
import { generateId } from '@/lib/utils';
import PreviewActionsMenu from './PreviewActionsMenu';
import ImagePreview from '@/components/preview/ImagePreview';
import { savePreviewCopy } from './previewFileActions';

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

// Window Controls Overlay stays native and always paints above the renderer. Keep "fullscreen"
// as a content-area maximize on Windows, matching the shell layout and leaving caption controls
// unobstructed. The 36px fallback matches WindowTitleBar's legacy Windows toolbar; WCO-capable
// builds resolve the real 30px height from the env value.
const WINDOWS_FULLSCREEN_STYLE = {
  top: 'calc(env(titlebar-area-y, 0px) + env(titlebar-area-height, 36px))',
} as const;

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
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'html', 'css', 'json'].includes(ext)) return AppIcons.fileCode;
  if (['md', 'txt', 'log'].includes(ext)) return AppIcons.file;
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return AppIcons.fileImage;
  if (['xlsx', 'xls', 'csv'].includes(ext)) return AppIcons.fileSheet;
  if (ext === 'pdf') return AppIcons.filePdf;
  if (ext === 'docx') return AppIcons.fileDocument;
  if (ext === 'pptx' || ext === 'ppt') return AppIcons.fileSlides;
  return AppIcons.fileGeneric;
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
  // The field names are the protocol with the injected script; the values are the
  // floating-layer tokens the in-app selection toolbar uses.
  return {
    bgBase: read('--ds-raised'),
    bgHover: read('--ds-fill-hover'),
    borderSubtle: read('--ds-separator'),
    textPrimary: read('--ds-label'),
    textTertiary: read('--ds-label-tertiary'),
    danger: read('--ds-danger'),
  };
}

function LazyFallback() {
  const { t } = useI18n();
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner label={t.panel.loadingDocument} />
    </div>
  );
}

type SaveState = 'saved' | 'saving' | 'error';

/**
 * The preview header. PreviewPanel re-renders on every keystroke in the source
 * editor; this is a memo with primitive and stable props so its tooltips and
 * menus do not re-render with each character.
 */
const PreviewToolbar = memo(function PreviewToolbar({
  filePath,
  fileName,
  rendererType,
  fileTypeLabel,
  saveState,
  viewMode,
  onViewModeChange,
  showVersionHistory,
  onShowVersionHistoryChange,
  onRevertVersion,
  onReload,
  onOpenInApp,
  onReveal,
  onCopyPath,
  onSaveAs,
  isFullscreen,
  onToggleFullscreen,
  showClose,
  onClose,
}: {
  filePath: string;
  fileName: string;
  rendererType: RendererType;
  fileTypeLabel: string;
  /** null when the file is not editable or failed to load: no save state is shown. */
  saveState: SaveState | null;
  viewMode: 'preview' | 'source';
  onViewModeChange: (mode: 'preview' | 'source') => void;
  showVersionHistory: boolean;
  onShowVersionHistoryChange: (open: boolean) => void;
  onRevertVersion: (id: string) => Promise<void>;
  onReload: () => void;
  onOpenInApp: () => void;
  onReveal: () => void;
  onCopyPath: () => void;
  onSaveAs: () => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  showClose: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const dataUrl = isDataUrl(filePath);
  const fileIcon = dataUrl ? AppIcons.fileImage : getFileIcon(filePath);
  const toolbarButtons = getToolbarButtons(rendererType);

  return (
    <div className={cn(
      'flex min-h-11 shrink-0 items-center gap-2 border-b border-separator px-3 py-1',
      isFullscreen && isMacOS() && 'pl-20',
    )}>
      <div className="flex min-w-0 flex-1 items-center gap-2" title={filePath}>
        <div className="flex size-7 shrink-0 items-center justify-center rounded-control bg-fill text-label-secondary">
          <Icon icon={fileIcon} size="sm" />
        </div>
        <span className="truncate text-ui font-medium text-label">
          {fileName}
        </span>
        {fileTypeLabel && (
          <span className="hidden shrink-0 min-[1100px]:inline-flex">
            <Tag>{fileTypeLabel}</Tag>
          </span>
        )}
        {saveState && (
          <span className={cn(
            'hidden shrink-0 items-center gap-2 text-ui min-[1300px]:inline-flex',
            saveState === 'error' ? 'text-danger' : 'text-label-secondary',
          )}>
            {saveState === 'saving' ? (
              <Spinner size="sm" labelSize="ui" label={t.panel.saving} />
            ) : (
              <>
                <StatusIcon tone={saveState === 'saved' ? 'success' : 'danger'} size="sm" />
                {saveState === 'saved' ? t.panel.saved : t.panel.saveError}
              </>
            )}
          </span>
        )}
      </div>

      {/* The tab strip sits right above this row, so these tooltips open below their buttons. */}
      <div className="flex shrink-0 items-center gap-1">
        <IconButton size="sm" tooltipSide="bottom" icon={AppIcons.reload} label={t.panel.reloadPreview} onClick={onReload} />
        {toolbarButtons.viewToggle && (
          <div className="mx-1 flex items-center gap-1 rounded-control bg-fill p-0.5">
            <IconButton
              size="sm"
              tooltipSide="bottom"
              icon={AppIcons.viewSource}
              label={t.panel.sourceMode}
              aria-pressed={viewMode === 'source'}
              onClick={() => onViewModeChange('source')}
            />
            <IconButton
              size="sm"
              tooltipSide="bottom"
              icon={AppIcons.preview}
              label={t.panel.previewMode}
              aria-pressed={viewMode === 'preview'}
              onClick={() => onViewModeChange('preview')}
            />
          </div>
        )}
        {toolbarButtons.versionHistory && (
          <VersionHistoryMenu
            filePath={filePath}
            open={showVersionHistory}
            onOpenChange={onShowVersionHistoryChange}
            trigger={<IconButton size="sm" tooltipSide="bottom" icon={AppIcons.history} label={t.panel.versionHistory} />}
            onRevert={onRevertVersion}
          />
        )}
        {toolbarButtons.openInApp && (
          <IconButton size="sm" tooltipSide="bottom" icon={AppIcons.openIn} label={t.panel.openInApp} onClick={onOpenInApp} />
        )}
        {!dataUrl && (
          <PreviewActionsMenu
            label={t.panel.moreActions}
            revealLabel={t.panel.showInFinder}
            copyPathLabel={t.panel.copyPath}
            saveAsLabel={t.panel.saveAs}
            onReveal={onReveal}
            onCopyPath={onCopyPath}
            onSaveAs={onSaveAs}
          />
        )}
        {toolbarButtons.fullscreen && (
          <IconButton
            size="sm"
            tooltipSide="bottom"
            icon={isFullscreen ? AppIcons.exitFullscreen : AppIcons.enlarge}
            label={isFullscreen ? t.panel.exitFullscreen : t.panel.fullscreen}
            onClick={onToggleFullscreen}
          />
        )}
        {showClose && (
          <IconButton size="sm" tooltipSide="bottom" icon={AppIcons.close} label={t.panel.closePreview} onClick={onClose} />
        )}
      </div>
    </div>
  );
});

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
  // Version history (P4) menu — controlled here so a file switch closes it.
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  // App-fullscreen toggle (Task 6) — expands the panel to a fixed overlay
  // covering the whole window instead of just its column in RightPanel.
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('saved');

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
  const canUseFileActions = !isDataUrl(previewFilePath ?? '');
  const fileTypeLabel = isDataUrl(previewFilePath ?? '')
    ? t.panel.imageType
    : getFileExtension(previewFilePath ?? '').toUpperCase();

  useEffect(() => {
    if (!previewFilePath) {
      setContent(null);
      setImageUrl(null);
      setHtmlPreviewUrl(null);
      setDraft('');
      lastSavedRef.current = '';
      selfEchoRef.current = null;
      establishedEditablePathRef.current = null;
      setSaveState('saved');
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
        setSaveState('saved');
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
    const nonce = generateId();
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
      // The picker payload's pageUrl is the loopback iframe's location.href,
      // which embeds the per-launch file-access token
      // (http://127.0.0.1:<port>/files/<TOKEN>/<root_id>/<path>). Never let
      // that flow into source.path (persisted history + sent to the LLM) —
      // swap in the real on-disk file path we already know instead. See
      // resolveReferencePath's doc comment.
      const ref = createDomElementReference({ ...payload, pageUrl: resolveReferencePath(previewFilePath, payload.pageUrl) });
      useChatStore.getState().addPendingReference(ref);
      // Single-select: exit inspect mode after one pick.
      disableInspect();
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [htmlPreviewUrl, disableInspect, previewFilePath]);

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
    if (draft === lastSavedRef.current) {
      setSaveState('saved');
      return;
    }

    setSaveState('saving');

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
          if (draftRef.current === contentToSave) setSaveState('saved');
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
          if (draftRef.current === contentToSave) setSaveState('error');
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
  // The handlers below are stable so the memoized toolbar keeps its props while the user types.
  const handleRevertVersion = useCallback(async (id: string) => {
    if (!previewFilePath) return;
    // Cancel the pending debounced autosave BEFORE awaiting revertToVersion,
    // not after. revertToVersion does its own read + pre-revert safety
    // snapshot + write, which stretches the await window; if the timer were
    // still armed during that window it could fire and write stale draft
    // content to disk right after the revert's write lands, silently undoing
    // the revert on disk (the in-memory draft below would still show the
    // reverted content, masking the problem until the next reload).
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    pendingSaveRef.current = null;
    const content = await revertToVersion(previewFilePath, id);
    selfEchoRef.current = content;
    lastSavedRef.current = content;
    setDraft(content);
    setSaveState('saved');
  }, [previewFilePath]);

  const handleOpenInFinder = useCallback(async () => {
    if (previewFilePath) {
      try {
        await revealItemInDir(previewFilePath);
      } catch (err) {
        console.error('Failed to open folder:', err);
      }
    }
  }, [previewFilePath]);

  const handleOpenInApp = useCallback(async () => {
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
  }, [previewFilePath, t]);

  const handleCopyPath = useCallback(async () => {
    if (!previewFilePath || !canUseFileActions) return;
    try {
      await writeText(previewFilePath);
      useToastStore.getState().addToast({ type: 'success', title: t.panel.copyPathDone });
    } catch (err) {
      console.error('[PreviewPanel] copy path failed:', err);
      useToastStore.getState().addToast({ type: 'error', title: t.panel.copyPathFailed });
    }
  }, [previewFilePath, canUseFileActions, t]);

  const handleSaveAs = useCallback(async () => {
    if (!previewFilePath || !canUseFileActions) return;
    try {
      const destination = await saveDialog({ defaultPath: previewFilePath });
      if (!destination || destination === previewFilePath) return;
      await savePreviewCopy({
        sourcePath: previewFilePath,
        destinationPath: destination,
        currentText: EDITABLE_TYPES.has(rendererType) ? draftRef.current : undefined,
      });
      useToastStore.getState().addToast({
        type: 'success',
        title: t.panel.saveAsDone,
        message: getBaseName(destination),
      });
    } catch (err) {
      console.error('[PreviewPanel] save as failed:', err);
      useToastStore.getState().addToast({
        type: 'error',
        title: t.panel.saveAsFailed,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [previewFilePath, canUseFileActions, rendererType, t]);

  const handleReload = useCallback(() => setReloadNonce((n) => n + 1), []);
  const handleToggleFullscreen = useCallback(() => setIsFullscreen((v) => !v), []);
  const exitFullscreen = useCallback(() => setIsFullscreen(false), []);
  const handleClose = useCallback(() => {
    if (tabId) closeTab(tabId);
    else closePreview();
  }, [tabId, closeTab, closePreview]);

  if (!previewFilePath) return null;

  return (
    // Fullscreen is a layout state of the panel, no dialog: the surface covers the window on the
    // sticky level, under the panel's own menus, and Escape leaves it unless the key was pressed
    // inside a menu or a window. Out of fullscreen the surface makes no box.
    <FullscreenSurface
      open={isFullscreen}
      onExit={exitFullscreen}
      label={fileName}
      // The macOS title-bar controls are fixed on the sticky level and come later in the page,
      // so a surface on that level is painted under them. The panel takes the popover level:
      // above the window chrome, and still under its own menus, which are drawn after it.
      className="z-popover bg-surface"
      style={isWindows() ? WINDOWS_FULLSCREEN_STYLE : undefined}
    >
    <div data-electron-no-drag className="flex h-full flex-col">
      {/* Content-first preview toolbar: identity stays anchored on the left,
          common reading/AI actions on the right, filesystem actions in More. */}
      <PreviewToolbar
        filePath={previewFilePath}
        fileName={fileName}
        rendererType={rendererType}
        fileTypeLabel={fileTypeLabel}
        saveState={EDITABLE_TYPES.has(rendererType) && !error ? saveState : null}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        showVersionHistory={showVersionHistory}
        onShowVersionHistoryChange={setShowVersionHistory}
        onRevertVersion={handleRevertVersion}
        onReload={handleReload}
        onOpenInApp={handleOpenInApp}
        onReveal={handleOpenInFinder}
        onCopyPath={handleCopyPath}
        onSaveAs={handleSaveAs}
        isFullscreen={isFullscreen}
        onToggleFullscreen={handleToggleFullscreen}
        showClose={!embedded || isFullscreen}
        onClose={handleClose}
      />

      {/* Browser-style location strip for HTML preview. Real
          back/forward + a CDP console panel are Electron-only (the loopback
          iframe is cross-origin, so its navigation history isn't observable) —
          documented as out of scope; use the browser tab for free navigation. */}
      {rendererType === 'html' && viewMode === 'preview' && (
        <div className="flex shrink-0 items-center gap-2 border-b border-separator px-2 py-1">
          <div className="flex h-6 min-w-0 flex-1 items-center gap-2 rounded-control bg-fill px-2">
            <Icon icon={AppIcons.webPage} size="sm" className="text-label-tertiary" />
            <span className="truncate text-caption text-label-secondary">{previewFilePath}</span>
          </div>
          <IconButton
            size="sm"
            icon={AppIcons.selectElement}
            label={t.panel.selectElement}
            aria-pressed={inspecting}
            disabled={!iframeLoaded}
            onClick={toggleInspect}
          />
        </div>
      )}

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Spinner label={t.panel.loadingDocument} />
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center p-4">
            <InlineMessage tone="danger">{error}</InlineMessage>
          </div>
        ) : rendererType === 'pdf' || rendererType === 'docx' || rendererType === 'pptx' || rendererType === 'xlsx' || (rendererType === 'csv' && content !== null) ? (
          <DocSelectionLayer filePath={previewFilePath} active={!embedded || tabId === activeTabId}>
            <Suspense fallback={<LazyFallback />}>
              {rendererType === 'pdf' && <PdfPreview filePath={previewFilePath} />}
              {rendererType === 'docx' && <DocxPreview filePath={previewFilePath} />}
              {rendererType === 'pptx' && <PptxPreview filePath={previewFilePath} />}
              {rendererType === 'xlsx' && <XlsxPreview filePath={previewFilePath} />}
              {rendererType === 'csv' && content !== null && <CsvPreview content={content} />}
            </Suspense>
          </DocSelectionLayer>
        ) : rendererType === 'image' && imageUrl ? (
          <ImagePreview src={imageUrl} alt={fileName} />
        ) : rendererType === 'markdown' && content !== null ? (
          viewMode === 'preview' ? (
            <ScrollArea className="h-full">
              <DocSelectionLayer filePath={previewFilePath} active={!embedded || tabId === activeTabId}>
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
                sandbox="allow-scripts allow-same-origin"
                className="h-full w-full border-0 bg-page-canvas"
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
          <div className="flex h-full items-center justify-center">
            <EmptyState
              icon={AppIcons.fileGeneric}
              title={t.panel.unsupportedFileType}
              action={<Button variant="secondary" icon={AppIcons.folderOpen} onClick={handleOpenInFinder}>{t.panel.showInFinder}</Button>}
            />
          </div>
        )}
      </div>
    </div>
    </FullscreenSurface>
  );
}
