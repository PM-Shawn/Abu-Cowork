import { useState, useEffect, useCallback } from 'react';
import { FileCode, FileText, FileImage, File, FileJson, ExternalLink, Globe } from 'lucide-react';
import { usePreviewStore } from '@/stores/previewStore';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { loadLocalImage, getBaseName, isLocalFilePath } from '@/utils/pathUtils';

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
    return { icon: FileText, label: 'PPTX', category: 'Presentation' };
  }
  if (['docx', 'doc'].includes(ext)) {
    return { icon: FileText, label: 'DOCX', category: 'Document' };
  }
  if (['xlsx', 'xls'].includes(ext)) {
    return { icon: FileText, label: 'XLSX', category: 'Spreadsheet' };
  }
  if (ext === 'pdf') {
    return { icon: FileText, label: 'PDF', category: 'Document' };
  }

  return { icon: File, label: ext.toUpperCase() || 'FILE', category: 'File' };
}

function isImageFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return IMAGE_EXTENSIONS.has(ext);
}

function isHtmlFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return ext === 'html' || ext === 'htm';
}

// eslint-disable-next-line react-refresh/only-export-components
export { IMAGE_EXTENSIONS, isImageFile };

interface FileAttachmentProps {
  filePath: string;
  operation?: 'read' | 'write' | 'create';
}

export default function FileAttachment({ filePath, operation }: FileAttachmentProps) {
  const openPreview = usePreviewStore((s) => s.openPreview);
  const { t } = useI18n();
  const { icon: Icon, label, category } = getFileTypeInfo(filePath);
  const fileName = getBaseName(filePath);
  const showThumbnail = isImageFile(filePath);
  const showBrowserBtn = isHtmlFile(filePath);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);

  // Load image thumbnail via Tauri readFile
  useEffect(() => {
    if (!showThumbnail) return;
    let cancelled = false;
    let blobUrl: string | null = null;
    loadLocalImage(filePath)
      .then((url) => {
        if (!cancelled) { blobUrl = url; setThumbUrl(url); }
        else URL.revokeObjectURL(url);
      })
      .catch(() => {});
    return () => { cancelled = true; if (blobUrl) URL.revokeObjectURL(blobUrl); };
  }, [filePath, showThumbnail]);

  const handleClick = () => {
    openPreview(filePath);
  };

  const handleOpenInBrowser = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const platform = navigator.platform.toLowerCase();
      const command = platform.includes('win')
        ? `start "" "${filePath}"`
        : platform.includes('linux')
          ? `xdg-open "${filePath}"`
          : `open "${filePath}"`;
      await invoke('run_shell_command', {
        command,
        cwd: null,
        background: true,
        timeout: 5,
        sandboxEnabled: false,
      });
    } catch (err) {
      console.error('[FileAttachment] Failed to open in browser:', err);
    }
  };

  // Image file: show thumbnail card
  if (showThumbnail && thumbUrl) {
    return (
      <div
        onClick={handleClick}
        className={cn(
          'group rounded-lg cursor-pointer transition-all overflow-hidden',
          'bg-white border border-[#e5e2db] hover:border-[#d97757]/40 hover:shadow-sm',
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
          <FileImage className="w-3.5 h-3.5 text-[#888579] shrink-0" />
          <span className="text-[12px] text-[#29261b] truncate">{fileName}</span>
        </div>
      </div>
    );
  }

  // Default: icon + text card
  return (
    <div
      className={cn(
        'group inline-flex items-center rounded-xl overflow-hidden transition-all',
        'bg-white border border-[#e5e2db] hover:shadow-sm',
        operation === 'create' && 'border-l-2 border-l-green-500',
        operation === 'write' && 'border-l-2 border-l-amber-500'
      )}
    >
      {/* File card area - clickable to preview */}
      <div
        onClick={handleClick}
        className="flex items-center gap-2.5 px-3 py-2.5 cursor-pointer hover:bg-[#f9f8f5] transition-colors"
        title={t.chat.clickToPreview}
      >
        {/* File Icon */}
        <div className={cn(
          'w-9 h-9 rounded-lg flex items-center justify-center shrink-0',
          'bg-[#f0eee8]'
        )}>
          <Icon className="w-4.5 h-4.5 text-[#656358]" />
        </div>

        {/* File Info */}
        <div className="flex flex-col min-w-0">
          <span className="text-[13px] font-medium text-[#29261b] truncate max-w-[160px]">
            {fileName.replace(/\.[^/.]+$/, '') || fileName}
          </span>
          <span className="text-[11px] text-[#888579]">
            {category} · {label}
          </span>
        </div>
      </div>

      {/* Open in Browser button for HTML files - separated by divider */}
      {showBrowserBtn && (
        <>
          <div className="w-px h-8 bg-[#e5e2db] shrink-0" />
          <button
            onClick={handleOpenInBrowser}
            className="flex items-center gap-1.5 px-3.5 py-2.5 cursor-pointer hover:bg-[#f9f8f5] transition-colors whitespace-nowrap"
            title={t.chat.openInBrowser}
          >
            <Globe className="w-4 h-4 text-[#888579]" />
            <span className="text-[12.5px] text-[#555249]">{t.chat.openInBrowser}</span>
          </button>
        </>
      )}
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
        'w-16 h-16 rounded-lg overflow-hidden border border-[#e5e2db] transition-all',
        'hover:border-[#d97757]/40 hover:shadow-sm',
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
        'bg-white border border-[#e5e2db] hover:border-[#d97757]/40 hover:shadow-md',
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
          <div className="w-full h-[80px] rounded bg-[#f5f3ee] flex items-center justify-center">
            <FileImage className={cn('w-8 h-8', loadFailed ? 'text-[#b8b5ab]' : 'text-[#d97757] animate-pulse')} />
          </div>
        )}
      </div>
      {/* File info */}
      <div className="px-2.5 pb-2 pt-0.5 flex items-center gap-1">
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-medium text-[#29261b] truncate">{fileName}</div>
          {dimensions && (
            <div className="text-[10px] text-[#b8b5ab] mt-0.5">{dimensions.w} × {dimensions.h}</div>
          )}
        </div>
        <button
          onClick={handleReveal}
          className="p-1 rounded hover:bg-[#f5f3ee] opacity-0 group-hover/card:opacity-100 transition-opacity shrink-0"
          title={t.chat.openInFinder}
        >
          <ExternalLink className="w-3 h-3 text-[#888579]" />
        </button>
      </div>
    </div>
  );
}
