import { memo, useState, useEffect, useCallback } from 'react';
import { usePreviewStore } from '@/stores/previewStore';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { useI18n, format } from '@/i18n';
import { cn } from '@/lib/utils';
import { loadLocalImage, getBaseName, isLocalFilePath } from '@/utils/pathUtils';
import { resolveFileSource, type ResolvedSource } from '@/core/session/outputSnapshots';
import { Button, IconButton } from '@/components/ds/button';
import { Pressable } from '@/components/ds/pressable';
import { Icon } from '@/components/ds/icon';
import { AppIcons, type AppIconName } from '@/components/ds/icons';

type AppIcon = (typeof AppIcons)[AppIconName];

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);

// Get file type info for display
function getFileTypeInfo(filePath: string): { icon: AppIcon; label: string; category: string } {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';

  // Code files
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'cpp', 'c', 'h'].includes(ext)) {
    return { icon: AppIcons.fileCode, label: ext.toUpperCase(), category: 'Code' };
  }
  // Config/data files
  if (['json', 'yaml', 'yml', 'toml', 'xml'].includes(ext)) {
    return { icon: AppIcons.fileJson, label: ext.toUpperCase(), category: 'Config' };
  }
  // HTML
  if (['html', 'htm'].includes(ext)) {
    return { icon: AppIcons.fileCode, label: 'HTML', category: 'Code' };
  }
  // Markdown
  if (ext === 'md') {
    return { icon: AppIcons.file, label: 'MD', category: 'Document' };
  }
  // Plain text
  if (['txt', 'log'].includes(ext)) {
    return { icon: AppIcons.file, label: ext.toUpperCase(), category: 'Text' };
  }
  // Images
  if (IMAGE_EXTENSIONS.has(ext) || ext === 'svg') {
    return { icon: AppIcons.fileImage, label: ext.toUpperCase(), category: 'Image' };
  }
  // CSS
  if (['css', 'scss', 'less'].includes(ext)) {
    return { icon: AppIcons.fileCode, label: 'CSS', category: 'Style' };
  }
  // Office documents
  if (['pptx', 'ppt'].includes(ext)) {
    return { icon: AppIcons.fileSlides, label: 'PPTX', category: 'Presentation' };
  }
  if (['docx', 'doc'].includes(ext)) {
    return { icon: AppIcons.fileDocument, label: 'DOCX', category: 'Document' };
  }
  if (['xlsx', 'xls'].includes(ext)) {
    return { icon: AppIcons.fileSheet, label: 'XLSX', category: 'Spreadsheet' };
  }
  if (ext === 'pdf') {
    return { icon: AppIcons.filePdf, label: 'PDF', category: 'Document' };
  }

  return { icon: AppIcons.fileGeneric, label: ext.toUpperCase() || 'FILE', category: 'File' };
}

// Get open-with label and icon by file extension
function getOpenWithInfo(filePath: string, labels: { preview: string; browser: string }): { label: string; icon: AppIcon } {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, { label: string; icon: AppIcon }> = {
    pptx: { label: 'PowerPoint', icon: AppIcons.fileSlides },
    ppt: { label: 'PowerPoint', icon: AppIcons.fileSlides },
    xlsx: { label: 'Excel', icon: AppIcons.fileSheet },
    xls: { label: 'Excel', icon: AppIcons.fileSheet },
    csv: { label: 'Excel', icon: AppIcons.fileSheet },
    docx: { label: 'Word', icon: AppIcons.fileDocument },
    doc: { label: 'Word', icon: AppIcons.fileDocument },
    pdf: { label: labels.preview, icon: AppIcons.filePdf },
    html: { label: labels.browser, icon: AppIcons.webPage },
    htm: { label: labels.browser, icon: AppIcons.webPage },
  };
  return map[ext] || { label: '', icon: AppIcons.openExternal };
}

function isImageFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return IMAGE_EXTENSIONS.has(ext);
}


// eslint-disable-next-line react-refresh/only-export-components
export { IMAGE_EXTENSIONS, isImageFile };

interface FileAttachmentProps {
  filePath: string;
  operation?: 'read' | 'write' | 'create';
  /** One sentence shown under the file name in place of the type label. */
  description?: string;
  /** The file was presented by the agent and checked on disk: the card reads `filePath` itself. */
  declared?: boolean;
}

// Flat card shared by every file card state.
const FILE_CARD = 'flex w-full items-center gap-3 rounded-panel border border-separator bg-surface px-4 py-3';
const FILE_ICON_BOX = 'flex h-10 w-10 shrink-0 items-center justify-center rounded-control bg-fill';

export default function FileAttachment({ filePath, description, declared = false }: FileAttachmentProps) {
  const openPreview = usePreviewStore((s) => s.openPreview);
  // Read conversationId directly from store rather than threading via props through
  // MessageGroup → MessageBubble → ToolCallView → FileAttachment.
  // Caveat: this only works when FileAttachment renders inside the active conversation.
  // If we ever render this card in a non-active context (e.g. conversation list preview),
  // pass conversationId via props and fall back to the store.
  const conversationId = useChatStore((s) => s.activeConversationId) ?? undefined;
  // Bumped by chatStore whenever the outputs manifest for this conversation
  // materially changes (e.g. share import finishes installing attachments).
  // Including this in the resolve effect's deps ensures the card re-resolves
  // once the async install settles, instead of getting stuck on the empty
  // snapshot it saw on first render.
  const outputsRev = useChatStore((s) => (conversationId ? s.outputsRev[conversationId] ?? 0 : 0));
  const workspacePath = useChatStore((s) => (conversationId ? (s.conversations[conversationId]?.workspacePath ?? null) : null));
  const { t } = useI18n();
  const { icon: fileIcon, label, category } = getFileTypeInfo(filePath);
  const fileName = getBaseName(filePath);
  const showThumbnail = isImageFile(filePath);
  const { label: openWithLabel, icon: openWithIcon } = getOpenWithInfo(filePath, { preview: t.chat.openWithPreview, browser: t.chat.openWithBrowser });
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [snapshotResolved, setResolved] = useState<ResolvedSource | null>(null);
  const resolved: ResolvedSource | null = declared
    ? { status: 'available', path: filePath, isFromSnapshot: false }
    : snapshotResolved;

  // Resolve where to actually load the file from: live original > snapshot > skipped/missing.
  // Re-runs when outputsRev bumps so async share-import writes become visible.
  useEffect(() => {
    if (declared) return;
    let cancelled = false;
    resolveFileSource(conversationId, filePath, workspacePath)
      .then((r) => { if (!cancelled) setResolved(r); })
      .catch(() => {
        if (!cancelled) setResolved({ status: 'missing', basename: getBaseName(filePath), originalPath: filePath });
      });
    return () => { cancelled = true; };
  }, [declared, filePath, conversationId, outputsRev, workspacePath]);

  // Effective path: where to actually read bytes from for thumbnail / preview / open-with.
  // null when the file is not loadable (skipped/missing/loading).
  const effectivePath = resolved && resolved.status === 'available' ? resolved.path : null;

  // Load image thumbnail via Tauri readFile (uses effective path so snapshots work)
  useEffect(() => {
    if (!showThumbnail || !effectivePath) {
      setThumbUrl(null);
      return;
    }
    let cancelled = false;
    let blobUrl: string | null = null;
    loadLocalImage(effectivePath)
      .then((url) => {
        if (!cancelled) { blobUrl = url; setThumbUrl(url); }
        else URL.revokeObjectURL(url);
      })
      .catch(() => {});
    return () => { cancelled = true; if (blobUrl) URL.revokeObjectURL(blobUrl); };
  }, [effectivePath, showThumbnail]);

  const handleClick = () => {
    if (effectivePath) openPreview(effectivePath);
  };

  const handleOpenWithDefaultApp = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!effectivePath) {
      useToastStore.getState().addToast({
        type: 'error',
        title: t.chat.openFailed,
        message: t.chat.fileMissing,
      });
      return;
    }
    try {
      const { openWithDefaultApp } = await import('@/utils/openWithDefaultApp');
      await openWithDefaultApp(effectivePath);
    } catch (err) {
      console.error('[FileAttachment] Failed to open with default app:', err);
      useToastStore.getState().addToast({
        type: 'error',
        title: t.chat.openFailed,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // Loading placeholder — match the standard card shape so the layout doesn't jump
  if (!resolved) {
    return (
      <div className={FILE_CARD}>
        <div className="h-5 w-32 rounded-control bg-fill" />
      </div>
    );
  }

  // Missing: no original on disk and no snapshot record at all
  if (resolved.status === 'missing') {
    return (
      <div className={cn(FILE_CARD, 'border-dashed')}>
        <div className={FILE_ICON_BOX}>
          <Icon icon={AppIcons.fileMissing} size="lg" className="text-label-tertiary" />
        </div>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-ui font-medium text-label-tertiary line-through" title={resolved.basename}>
            {resolved.basename}
          </span>
          <span className="text-caption text-label-tertiary">
            {t.chat.fileMissing}
          </span>
        </div>
      </div>
    );
  }

  // Skipped: manifest knows about it but no usable snapshot (oversized or copy-failed)
  if (resolved.status === 'skipped') {
    const reasonLabel =
      resolved.entry.skipReason === 'oversized'
        ? t.chat.fileOversized
        : t.chat.fileBackupFailed;
    return (
      <div className={FILE_CARD}>
        <div className={FILE_ICON_BOX}>
          <Icon icon={AppIcons.fileNotBackedUp} size="lg" className="text-warning" />
        </div>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-ui font-medium text-label" title={resolved.entry.basename}>
            {resolved.entry.basename}
          </span>
          <span className="text-caption text-label-tertiary">
            {reasonLabel}
          </span>
        </div>
      </div>
    );
  }

  // status === 'available' — file is loadable, render normally regardless of source.
  // No badge / no visual difference between live and snapshot — the user just sees a file.

  // Image file: show thumbnail card
  if (showThumbnail && thumbUrl) {
    return (
      <Pressable
        onClick={handleClick}
        className="block max-w-60 overflow-hidden rounded-panel border border-separator bg-surface text-left transition-colors duration-fast hover:border-control-border"
        title={t.chat.clickToPreviewImage}
      >
        <img
          src={thumbUrl}
          alt=""
          className="max-h-44 w-full object-cover"
          onError={() => setThumbUrl(null)}
        />
        <span className="flex items-center gap-2 px-2 py-1">
          <Icon icon={AppIcons.fileImage} size="sm" className="text-label-secondary" />
          <span className="truncate text-ui-sm text-label" title={fileName}>{fileName}</span>
        </span>
      </Pressable>
    );
  }

  // Default: icon + text card
  return (
    <div className={cn(FILE_CARD, 'transition-colors duration-fast hover:border-control-border')}>
      {/* File card area - clickable to preview */}
      <Pressable
        onClick={handleClick}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-control text-left"
        title={t.chat.clickToPreview}
      >
        <span className={FILE_ICON_BOX}>
          <Icon icon={fileIcon} size="lg" className="text-label-secondary" />
        </span>

        {/* File Info */}
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-ui font-medium text-label" title={fileName}>
            {fileName.replace(/\.[^/.]+$/, '') || fileName}
          </span>
          {description ? (
            <span className="truncate text-caption text-label-tertiary" title={description}>
              {description}
            </span>
          ) : (
            <span className="text-caption text-label-tertiary">
              {category} · {label}
            </span>
          )}
        </span>
      </Pressable>

      {/* Open with default app button */}
      <Button variant="secondary" size="sm" icon={openWithIcon} onClick={handleOpenWithDefaultApp} className="whitespace-nowrap">
        {openWithLabel ? format(t.chat.openWith, { label: openWithLabel }) : t.chat.openWithDefaultApp}
      </Button>
    </div>
  );
}

// Small square thumbnail for images referenced in markdown text
export function ImageThumbnail({ src }: { src: string }) {
  const openPreview = usePreviewStore((s) => s.openPreview);
  const { t } = useI18n();
  const isLocalPath = isLocalFilePath(src);
  const [imgUrl, setImgUrl] = useState<string | null>(() => isLocalPath ? null : src);

  useEffect(() => {
    if (!isLocalPath) return;
    let cancelled = false;
    let blobUrl: string | null = null;
    loadLocalImage(src)
      .then((url) => {
        if (!cancelled) { blobUrl = url; setImgUrl(url); }
        else URL.revokeObjectURL(url);
      })
      .catch(() => {});
    return () => { cancelled = true; if (blobUrl) URL.revokeObjectURL(blobUrl); };
  }, [src, isLocalPath]);

  if (!imgUrl) return null;

  const image = (
    <img
      src={imgUrl}
      alt=""
      className="h-full w-full object-cover"
      onError={() => setImgUrl(null)}
    />
  );
  const frame = 'h-16 w-16 overflow-hidden rounded-control border border-separator';

  // Only local files open in the preview; a web image is just shown.
  if (!isLocalPath) {
    return <div className={frame} title={src}>{image}</div>;
  }
  return (
    <Pressable
      onClick={() => openPreview(src)}
      className={cn(frame, 'transition-colors duration-fast hover:border-control-border')}
      title={t.chat.clickToPreviewFull}
      aria-label={t.chat.clickToPreviewFull}
    >
      {image}
    </Pressable>
  );
}

// Compact image preview card for generated images. Memoized: its reveal button carries a
// tooltip, and finished message groups re-render with every streamed token of a later reply.
export const ImagePreviewCard = memo(function ImagePreviewCard({ filePath }: { filePath: string }) {
  const openPreview = usePreviewStore((s) => s.openPreview);
  const { t } = useI18n();
  const fileName = getBaseName(filePath);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [dimensions, setDimensions] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let blobUrl: string | null = null;
    loadLocalImage(filePath)
      .then((url) => {
        if (!cancelled) { blobUrl = url; setImgUrl(url); }
        else URL.revokeObjectURL(url);
      })
      .catch((err) => {
        console.error('[ImagePreviewCard] Failed to load:', filePath, err);
        if (!cancelled) setLoadFailed(true);
      });
    return () => { cancelled = true; if (blobUrl) URL.revokeObjectURL(blobUrl); };
  }, [filePath]);

  const handleImgLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    if (img.naturalWidth && img.naturalHeight) {
      setDimensions({ w: img.naturalWidth, h: img.naturalHeight });
    }
  }, []);

  const handleReveal = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
      await revealItemInDir(filePath);
    } catch { /* ignore in non-Tauri env */ }
  };

  return (
    <div className="group/card relative inline-block overflow-hidden rounded-panel border border-separator bg-surface align-bottom transition-colors duration-fast hover:border-control-border">
      {/* Image-first: the thumbnail IS the card, no persistent filename/size
          chrome. Metadata + actions live in a hover overlay so the default
          look is just a clean rounded thumbnail. */}
      <Pressable
        onClick={() => openPreview(filePath)}
        className="block"
        title={t.chat.clickToPreview}
      >
        {imgUrl ? (
          <img
            src={imgUrl}
            alt={fileName}
            className="block max-h-50 w-auto max-w-50 object-contain"
            onLoad={handleImgLoad}
            onError={() => { setImgUrl(null); setLoadFailed(true); }}
          />
        ) : (
          <span className="flex h-30 w-40 items-center justify-center bg-fill">
            <Icon icon={AppIcons.fileImage} size="lg" className={loadFailed ? 'text-label-placeholder' : 'text-label-tertiary'} />
          </span>
        )}
      </Pressable>
      {/* Hover overlay: filename + dimensions + reveal-in-Finder, as small raised chips
          over the image. Clicks outside the reveal button fall through to the preview. */}
      {imgUrl && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1 p-1 opacity-0 transition-opacity duration-fast group-hover/card:opacity-100 group-focus-within/card:opacity-100">
          <span className="flex min-w-0 flex-1 items-center gap-1 rounded-control bg-raised px-2 py-1 text-caption text-label shadow-float">
            <span className="min-w-0 flex-1 truncate font-medium">{fileName}</span>
            {dimensions && (
              <span className="shrink-0 text-label-secondary">{dimensions.w}×{dimensions.h}</span>
            )}
          </span>
          <IconButton
            icon={AppIcons.folderOpen}
            label={t.chat.openInFinder}
            size="sm"
            onClick={handleReveal}
            className="pointer-events-auto bg-raised text-label shadow-float hover:bg-raised"
          />
        </div>
      )}
    </div>
  );
});
