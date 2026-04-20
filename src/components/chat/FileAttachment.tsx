import { useState, useEffect, useCallback } from 'react';
import { FileCode, FileText, FileImage, File, FileJson, ExternalLink, Globe, SquareArrowOutUpRight, Presentation, Sheet, FileType2, FileSearch, FileX, FileWarning } from 'lucide-react';
import { usePreviewStore } from '@/stores/previewStore';
import { useChatStore } from '@/stores/chatStore';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { loadLocalImage, getBaseName, isLocalFilePath } from '@/utils/pathUtils';
import { resolveFileSource, type ResolvedSource } from '@/core/session/outputSnapshots';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);

// Get file type info for display
function getFileTypeInfo(filePath: string): { icon: typeof File; label: string; category: string } {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';

  // Code files
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'cpp', 'c', 'h'].includes(ext)) {
    return { icon: FileCode, label: ext.toUpperCase(), category: 'Code' };
  }
  // Config/data files
  if (['json', 'yaml', 'yml', 'toml', 'xml'].includes(ext)) {
    return { icon: FileJson, label: ext.toUpperCase(), category: 'Config' };
  }
  // HTML
  if (['html', 'htm'].includes(ext)) {
    return { icon: FileCode, label: 'HTML', category: 'Code' };
  }
  // Markdown
  if (ext === 'md') {
    return { icon: FileText, label: 'MD', category: 'Document' };
  }
  // Plain text
  if (['txt', 'log'].includes(ext)) {
    return { icon: FileText, label: ext.toUpperCase(), category: 'Text' };
  }
  // Images
  if (IMAGE_EXTENSIONS.has(ext) || ext === 'svg') {
    return { icon: FileImage, label: ext.toUpperCase(), category: 'Image' };
  }
  // CSS
  if (['css', 'scss', 'less'].includes(ext)) {
    return { icon: FileCode, label: 'CSS', category: 'Style' };
  }
  // Office documents
  if (['pptx', 'ppt'].includes(ext)) {
    return { icon: Presentation, label: 'PPTX', category: 'Presentation' };
  }
  if (['docx', 'doc'].includes(ext)) {
    return { icon: FileType2, label: 'DOCX', category: 'Document' };
  }
  if (['xlsx', 'xls'].includes(ext)) {
    return { icon: Sheet, label: 'XLSX', category: 'Spreadsheet' };
  }
  if (ext === 'pdf') {
    return { icon: FileSearch, label: 'PDF', category: 'Document' };
  }

  return { icon: File, label: ext.toUpperCase() || 'FILE', category: 'File' };
}

// Get open-with label and icon by file extension
function getOpenWithInfo(filePath: string): { label: string; icon: typeof File } {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, { label: string; icon: typeof File }> = {
    pptx: { label: 'PowerPoint', icon: Presentation },
    ppt: { label: 'PowerPoint', icon: Presentation },
    xlsx: { label: 'Excel', icon: Sheet },
    xls: { label: 'Excel', icon: Sheet },
    csv: { label: 'Excel', icon: Sheet },
    docx: { label: 'Word', icon: FileType2 },
    doc: { label: 'Word', icon: FileType2 },
    pdf: { label: '预览', icon: FileSearch },
    html: { label: '浏览器', icon: Globe },
    htm: { label: '浏览器', icon: Globe },
  };
  return map[ext] || { label: '', icon: SquareArrowOutUpRight };
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
}

export default function FileAttachment({ filePath }: FileAttachmentProps) {
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
  const { t } = useI18n();
  const { icon: Icon, label, category } = getFileTypeInfo(filePath);
  const fileName = getBaseName(filePath);
  const showThumbnail = isImageFile(filePath);
  const { label: openWithLabel, icon: OpenWithIcon } = getOpenWithInfo(filePath);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [resolved, setResolved] = useState<ResolvedSource | null>(null);

  // Resolve where to actually load the file from: live original > snapshot > skipped/missing.
  // Re-runs when outputsRev bumps so async share-import writes become visible.
  useEffect(() => {
    let cancelled = false;
    resolveFileSource(conversationId, filePath)
      .then((r) => { if (!cancelled) setResolved(r); })
      .catch(() => {
        if (!cancelled) setResolved({ status: 'missing', basename: getBaseName(filePath), originalPath: filePath });
      });
    return () => { cancelled = true; };
  }, [filePath, conversationId, outputsRev]);

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
    if (!effectivePath) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const platform = navigator.platform.toLowerCase();
      const command = platform.includes('win')
        ? `start "" "${effectivePath}"`
        : platform.includes('linux')
          ? `xdg-open "${effectivePath}"`
          : `open "${effectivePath}"`;
      await invoke('run_shell_command', {
        command,
        cwd: null,
        background: true,
        timeout: 5,
        sandboxEnabled: false,
      });
    } catch (err) {
      console.error('[FileAttachment] Failed to open with default app:', err);
    }
  };

  // Loading skeleton — match the standard card shape so the layout doesn't jump
  if (!resolved) {
    return (
      <div className="w-full rounded-lg bg-[var(--abu-bg-muted)] border border-[var(--abu-border)] px-4 py-3 opacity-50">
        <div className="h-5 w-32 bg-[var(--abu-border)] rounded animate-pulse" />
      </div>
    );
  }

  // Missing: no original on disk and no snapshot record at all
  if (resolved.status === 'missing') {
    return (
      <div className="flex items-center gap-3 w-full rounded-lg border border-dashed border-[var(--abu-border)] bg-[var(--abu-bg-muted)] px-4 py-3 opacity-60">
        <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 bg-[var(--abu-bg-muted)]">
          <FileX className="w-5 h-5 text-[var(--abu-text-muted)]" />
        </div>
        <div className="flex flex-col min-w-0">
          <span className="text-[13.5px] font-medium text-[var(--abu-text-muted)] truncate line-through">
            {resolved.basename}
          </span>
          <span className="text-[11px] text-[var(--abu-text-muted)]">
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
      <div className="flex items-center gap-3 w-full rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-muted)] px-4 py-3 opacity-70">
        <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 bg-[var(--abu-bg-muted)]">
          <FileWarning className="w-5 h-5 text-amber-500/80" />
        </div>
        <div className="flex flex-col min-w-0">
          <span className="text-[13.5px] font-medium text-[var(--abu-text-primary)] truncate">
            {resolved.entry.basename}
          </span>
          <span className="text-[11px] text-[var(--abu-text-muted)]">
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
      <div
        onClick={handleClick}
        className={cn(
          'group rounded-lg cursor-pointer transition-all overflow-hidden',
          'bg-[var(--abu-bg-muted)] border border-[var(--abu-border)] hover:border-[var(--abu-clay-40)]',
          'max-w-[240px]'
        )}
        title="点击预览图片"
      >
        <img
          src={thumbUrl}
          alt={fileName}
          className="w-full max-h-[180px] object-cover"
          onError={() => setThumbUrl(null)}
        />
        <div className="px-2.5 py-1.5 flex items-center gap-2">
          <FileImage className="w-3.5 h-3.5 text-[var(--abu-text-muted)] shrink-0" />
          <span className="text-[12px] text-[var(--abu-text-primary)] truncate">{fileName}</span>
        </div>
      </div>
    );
  }

  // Default: icon + text card
  return (
    <div
      className={cn(
        'group flex items-center gap-3 w-full rounded-lg transition-all',
        'bg-[var(--abu-bg-muted)] border border-[var(--abu-border)] hover:border-[var(--abu-border-hover)]',
        'px-4 py-3',
      )}
    >
      {/* File card area - clickable to preview */}
      <div
        onClick={handleClick}
        className="flex items-center gap-3 min-w-0 flex-1 cursor-pointer"
        title={t.chat.clickToPreview}
      >
        {/* File Icon */}
        <div className={cn(
          'w-10 h-10 rounded-lg flex items-center justify-center shrink-0',
          'bg-[var(--abu-bg-muted)]'
        )}>
          <Icon className="w-5 h-5 text-[var(--abu-text-tertiary)]" />
        </div>

        {/* File Info */}
        <div className="flex flex-col min-w-0">
          <span className="text-[13.5px] font-medium text-[var(--abu-text-primary)] truncate">
            {fileName.replace(/\.[^/.]+$/, '') || fileName}
          </span>
          <span className="text-[11px] text-[var(--abu-text-muted)]">
            {category} · {label}
          </span>
        </div>
      </div>

      {/* Open with default app button */}
      <button
        onClick={handleOpenWithDefaultApp}
        className={cn(
          'flex items-center gap-1.5 px-3 py-2 shrink-0 cursor-pointer whitespace-nowrap',
          'rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-base)] hover:bg-[var(--abu-bg-muted)] transition-colors',
        )}
        title={openWithLabel ? `用 ${openWithLabel} 打开` : t.chat.openWithDefaultApp}
      >
        <OpenWithIcon className="w-4 h-4 text-[var(--abu-text-muted)]" />
        <span className="text-[12.5px] text-[var(--abu-text-tertiary)]">
          {openWithLabel ? `用 ${openWithLabel} 打开` : t.chat.openWithDefaultApp}
        </span>
      </button>
    </div>
  );
}

// Small square thumbnail for images referenced in markdown text
export function ImageThumbnail({ src }: { src: string }) {
  const openPreview = usePreviewStore((s) => s.openPreview);
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

  return (
    <div
      onClick={() => isLocalPath && openPreview(src)}
      className={cn(
        'w-16 h-16 rounded-lg overflow-hidden border border-[var(--abu-bg-pressed)] transition-all',
        'hover:border-[var(--abu-clay-40)]',
        isLocalPath && 'cursor-pointer'
      )}
      title={isLocalPath ? '点击预览大图' : src}
    >
      <img
        src={imgUrl}
        alt=""
        className="w-full h-full object-cover"
        onError={() => setImgUrl(null)}
      />
    </div>
  );
}

// Compact image preview card for generated images
export function ImagePreviewCard({ filePath }: { filePath: string }) {
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
    <div
      onClick={() => openPreview(filePath)}
      className={cn(
        'group/card inline-block rounded-lg cursor-pointer transition-all overflow-hidden relative',
        'bg-[var(--abu-bg-muted)] border border-[var(--abu-border)] hover:border-[var(--abu-clay-40)]',
        'max-w-[240px]'
      )}
      title={t.chat.clickToPreview}
    >
      {/* Thumbnail or fallback */}
      <div className="p-1.5">
        {imgUrl ? (
          <img
            src={imgUrl}
            alt={fileName}
            className="w-full h-auto max-h-[160px] object-contain rounded"
            onLoad={handleImgLoad}
            onError={() => { setImgUrl(null); setLoadFailed(true); }}
          />
        ) : (
          <div className="w-full h-[80px] rounded bg-[var(--abu-bg-muted)] flex items-center justify-center">
            <FileImage className={cn('w-8 h-8', loadFailed ? 'text-[var(--abu-text-placeholder)]' : 'text-[var(--abu-clay)] animate-pulse')} />
          </div>
        )}
      </div>
      {/* File info */}
      <div className="px-2.5 pb-2 pt-0.5 flex items-center gap-1">
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-medium text-[var(--abu-text-primary)] truncate">{fileName}</div>
          {dimensions && (
            <div className="text-[10px] text-[var(--abu-text-placeholder)] mt-0.5">{dimensions.w} × {dimensions.h}</div>
          )}
        </div>
        <button
          onClick={handleReveal}
          className="p-1 rounded hover:bg-[var(--abu-bg-muted)] opacity-0 group-hover/card:opacity-100 transition-opacity shrink-0"
          title={t.chat.openInFinder}
        >
          <ExternalLink className="w-3 h-3 text-[var(--abu-text-muted)]" />
        </button>
      </div>
    </div>
  );
}
