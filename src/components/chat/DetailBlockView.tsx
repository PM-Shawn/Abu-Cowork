import { useState, useMemo, useEffect, useRef, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, ImageOff, Maximize2, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n, format } from '@/i18n';
import { getDetailBlockLabel } from '@/utils/toolLabels';
import type { DetailBlock } from '@/types/execution';
import { useChatStore } from '@/stores/chatStore';
import { resolveOutputRefSource } from '@/core/session/outputSnapshots';
import { loadLocalImage } from '@/utils/pathUtils';

interface DetailBlockViewProps {
  block: DetailBlock;
  onToggle: () => void;
  onLoadMore?: () => void;
}

type OutputRefImageState = 'idle' | 'loading' | 'ready' | 'unavailable';

function formatImageSize(bytes: number | undefined): string | null {
  if (bytes === undefined || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}

/**
 * DetailBlockView - Collapsible content area for tool input/output
 * Supports multiple types: script, result, error, list, json, diff, table
 * Uses local state for toggle with optional store sync via onToggle.
 */
export default function DetailBlockView({ block, onToggle, onLoadMore }: DetailBlockViewProps) {
  const { locale, t } = useI18n();
  const outputRef = block.type === 'image' ? block.imageData?.outputRef : undefined;
  const activeConversationId = useChatStore((state) => (
    outputRef?.relPath ? state.activeConversationId : null
  ));
  // Local expanded state — syncs with block.isExpanded from store when available
  const [localExpanded, setLocalExpanded] = useState(block.isExpanded);
  const [imageFullscreen, setImageFullscreen] = useState(false);
  const [outputRefSrc, setOutputRefSrc] = useState<string | null>(null);
  const [outputRefState, setOutputRefState] = useState<OutputRefImageState>(() => (
    outputRef?.relPath ? 'loading' : 'idle'
  ));
  const [retryNonce, setRetryNonce] = useState(0);
  const outputRefObjectUrlRef = useRef<string | null>(null);

  // Sync from external state changes (e.g. store updates during live execution)
  useEffect(() => {
    setLocalExpanded(block.isExpanded);
  }, [block.isExpanded]);

  const handleToggle = () => {
    setLocalExpanded((prev) => !prev);
    onToggle(); // Also try store update (may be no-op for persisted snapshots)
  };
  // Localize the collapsible header at render time so it follows the current UI
  // locale (block.labelKey is language-neutral). Falls back to the baked label.
  const headerLabel = block.labelKey ? getDetailBlockLabel(block.labelKey, locale) : block.label;

  // Build the data URL once per payload — the base64 can be megabytes, so it
  // must not be re-concatenated on every render.
  const inlineImageSrc = useMemo(
    () => (block.imageData?.base64 ? `data:${block.imageData.mediaType};base64,${block.imageData.base64}` : null),
    [block.imageData],
  );
  const imageSrc = inlineImageSrc ?? outputRefSrc;

  useEffect(() => {
    if (block.type !== 'image' || inlineImageSrc || !outputRef?.relPath) {
      setOutputRefState('idle');
      if (outputRefObjectUrlRef.current) {
        URL.revokeObjectURL(outputRefObjectUrlRef.current);
        outputRefObjectUrlRef.current = null;
      }
      setOutputRefSrc(null);
      return;
    }

    let cancelled = false;
    let blobUrl: string | null = null;
    setOutputRefState('loading');
    if (outputRefObjectUrlRef.current) {
      URL.revokeObjectURL(outputRefObjectUrlRef.current);
      outputRefObjectUrlRef.current = null;
    }
    setOutputRefSrc(null);

    resolveOutputRefSource(activeConversationId ?? undefined, outputRef.relPath)
      .then(async (resolved) => {
        if (cancelled) return;
        if (resolved.status !== 'available') {
          setOutputRefState('unavailable');
          return;
        }
        blobUrl = await loadLocalImage(resolved.path);
        if (cancelled) {
          URL.revokeObjectURL(blobUrl);
          return;
        }
        outputRefObjectUrlRef.current = blobUrl;
        setOutputRefSrc(blobUrl);
        setOutputRefState('ready');
      })
      .catch(() => {
        if (!cancelled) setOutputRefState('unavailable');
      });

    return () => {
      cancelled = true;
      if (blobUrl && outputRefObjectUrlRef.current !== blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [activeConversationId, block.type, inlineImageSrc, outputRef?.relPath, retryNonce]);

  useEffect(() => () => {
    if (outputRefObjectUrlRef.current) {
      URL.revokeObjectURL(outputRefObjectUrlRef.current);
      outputRefObjectUrlRef.current = null;
    }
  }, []);

  // Style based on block type
  const styles = useMemo(() => {
    switch (block.type) {
      case 'error':
        return {
          labelBg: 'bg-[var(--abu-danger-bg)]',
          labelText: 'text-[var(--abu-danger)]',
          contentBg: 'bg-[var(--abu-danger-bg)]',
          borderColor: 'border-[var(--abu-danger)]',
        };
      case 'script':
        return {
          labelBg: 'bg-[var(--abu-bg-hover)]',
          labelText: 'text-[var(--abu-text-tertiary)]',
          contentBg: 'bg-[var(--abu-bg-muted)]',
          borderColor: 'border-[var(--abu-bg-hover)]',
        };
      case 'list':
        return {
          labelBg: 'bg-[var(--abu-info-bg)]',
          labelText: 'text-[var(--abu-info)]',
          contentBg: 'bg-[var(--abu-info-bg)]',
          borderColor: 'border-[var(--abu-info)]',
        };
      case 'json':
        return {
          labelBg: 'bg-purple-50',
          labelText: 'text-purple-600',
          contentBg: 'bg-purple-50/50',
          borderColor: 'border-purple-100',
        };
      case 'image':
        return {
          labelBg: 'bg-[var(--abu-success-bg)]',
          labelText: 'text-[var(--abu-success)]',
          contentBg: 'bg-[var(--abu-bg-base)]',
          borderColor: 'border-[var(--abu-success)]',
        };
      default:
        return {
          labelBg: 'bg-[var(--abu-bg-hover)]',
          labelText: 'text-[var(--abu-text-muted)]',
          contentBg: 'bg-[var(--abu-bg-muted)]',
          borderColor: 'border-[var(--abu-bg-hover)]',
        };
    }
  }, [block.type]);

  // Render content based on type
  const renderContent = () => {
    switch (block.type) {
      case 'image':
        return renderImageContent();
      case 'list':
        return renderListContent();
      case 'json':
        return renderJsonContent();
      case 'table':
        return renderTableContent();
      default:
        return renderTextContent();
    }
  };

  // Render plain text/code content
  const renderTextContent = () => (
    <>
      {/* Language tag */}
      {block.language && (
        <div className="px-3 py-1.5 text-caption text-[var(--abu-text-muted)] bg-[var(--abu-bg-hover)] border-b border-[var(--abu-bg-hover)]">
          {block.language}
        </div>
      )}

      {/* Content area */}
      <pre className={cn(
        'px-3 py-2 text-minor font-mono whitespace-pre-wrap break-all overflow-x-auto max-h-[300px] overflow-y-auto',
        block.type === 'error' ? 'text-[var(--abu-danger)]' : 'text-[var(--abu-text-tertiary)]'
      )}>
        {block.content}
      </pre>

      {/* Load more button */}
      {block.isTruncated && onLoadMore && (
        <div className="px-3 py-2 border-t border-[var(--abu-bg-hover)]">
          <button
            onClick={onLoadMore}
            className="text-caption text-[var(--abu-clay)] hover:underline"
          >
            {t.chat.viewMore} ({(block.fullContentLength || 0) - block.content.length} {t.chat.characters})
          </button>
        </div>
      )}
    </>
  );

  // Render image content (from read_file images, screenshots)
  const renderImageContent = () => {
    const filename = outputRef?.basename || block.content || t.chat.imageExpired;
    const size = formatImageSize(outputRef?.sizeBytes);
    const metadata = size ? `${filename} · ${size}` : filename;

    const renderImageFrame = (children: ReactNode, interactive: boolean) => (
      <div className="p-2">
        <div
          className={cn(
            'relative group w-[320px] h-[200px] rounded border border-[var(--abu-bg-hover)] overflow-hidden bg-[var(--abu-bg-muted)] flex items-center justify-center',
            interactive && 'cursor-pointer',
          )}
          onClick={interactive ? () => setImageFullscreen(true) : undefined}
        >
          {children}
          {interactive && (
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
              <Maximize2 className="h-5 w-5 text-white opacity-0 group-hover:opacity-80 transition-opacity" />
            </div>
          )}
        </div>
        <div className="mt-1 text-caption text-[var(--abu-text-muted)] truncate max-w-[320px]">{metadata}</div>
      </div>
    );

    if (!imageSrc) {
      if (outputRef?.relPath && outputRefState === 'loading') {
        return renderImageFrame(
          <div className="text-caption text-[var(--abu-text-muted)]">{t.chat.imageLoading}</div>,
          false,
        );
      }
      return renderImageFrame(
        <div className="flex flex-col items-center gap-2 px-4 text-center">
          <ImageOff className="h-6 w-6 text-[var(--abu-text-muted)]" />
          <div className="text-caption text-[var(--abu-text-muted)]">{t.chat.imageUnavailable}</div>
          {outputRef?.relPath && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setRetryNonce((value) => value + 1);
              }}
              className="inline-flex items-center gap-1 text-caption text-[var(--abu-link)] hover:text-[var(--abu-link-hover)]"
            >
              <RefreshCw className="h-3 w-3" />
              {t.chat.imageRetry}
            </button>
          )}
        </div>,
        false,
      );
    }

    return (
      <>
        {renderImageFrame(
            <img
              src={imageSrc}
              alt={block.content || 'Image'}
              className="max-w-full max-h-full object-contain"
            />,
            true,
        )}
        {imageFullscreen && (
          <div
            data-electron-no-drag
            className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-8 cursor-pointer"
            onClick={() => setImageFullscreen(false)}
          >
            <img
              src={imageSrc}
              alt={block.content || 'Image (full)'}
              className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
            />
          </div>
        )}
      </>
    );
  };

  // Render list content (e.g., search results)
  const renderListContent = () => {
    if (!block.parsedItems || block.parsedItems.length === 0) {
      return renderTextContent();
    }

    return (
      <div className="divide-y divide-[var(--abu-bg-hover)]">
        {block.parsedItems.slice(0, 5).map((item, index) => (
          <div key={index} className="px-3 py-2 hover:bg-[var(--abu-bg-hover)] transition-colors">
            <div className="flex items-start gap-2">
              {item.icon && <span className="text-minor">{item.icon}</span>}
              <div className="flex-1 min-w-0">
                {item.url ? (
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-minor text-[var(--abu-text-tertiary)] hover:text-[var(--abu-clay)] font-medium flex items-center gap-1"
                  >
                    {item.title}
                    <ExternalLink className="h-3 w-3 opacity-50" />
                  </a>
                ) : (
                  <div className="text-minor text-[var(--abu-text-tertiary)] font-medium">{item.title}</div>
                )}
                {item.description && (
                  <div className="text-caption text-[var(--abu-text-muted)] mt-0.5 line-clamp-2">
                    {item.description}
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
        {block.parsedItems.length > 5 && (
          <div className="px-3 py-2 text-caption text-[var(--abu-text-muted)]">
            {format(t.chat.moreItems, { count: block.parsedItems.length - 5 })}
          </div>
        )}
      </div>
    );
  };

  // Render JSON content with syntax highlighting
  const renderJsonContent = () => {
    let formattedJson = block.content;
    try {
      const parsed = JSON.parse(block.content);
      formattedJson = JSON.stringify(parsed, null, 2);
    } catch {
      // If parsing fails, show as-is
    }

    return (
      <pre className="px-3 py-2 text-minor text-[var(--abu-text-tertiary)] font-mono whitespace-pre-wrap break-all overflow-x-auto max-h-[300px] overflow-y-auto">
        {formattedJson}
      </pre>
    );
  };

  // Render table content
  const renderTableContent = () => {
    if (!block.tableData) {
      return renderTextContent();
    }

    const { headers, rows } = block.tableData;

    return (
      <div className="overflow-x-auto">
        <table className="w-full text-minor">
          <thead>
            <tr className="bg-[var(--abu-bg-hover)]">
              {headers.map((header, i) => (
                <th key={i} className="px-3 py-1.5 text-left text-[var(--abu-text-tertiary)] font-medium border-b border-[var(--abu-bg-hover)]">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 10).map((row, i) => (
              <tr key={i} className="hover:bg-[var(--abu-bg-muted)]">
                {row.map((cell, j) => (
                  <td key={j} className="px-3 py-1.5 text-[var(--abu-text-tertiary)] border-b border-[var(--abu-bg-hover)]">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > 10 && (
          <div className="px-3 py-2 text-caption text-[var(--abu-text-muted)] border-t border-[var(--abu-bg-hover)]">
            {format(t.chat.moreRows, { count: rows.length - 10 })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="mt-1">
      {/* Label button */}
      <button
        onClick={handleToggle}
        className={cn(
          'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-caption',
          'transition-colors',
          styles.labelBg,
          styles.labelText,
          'hover:opacity-80'
        )}
      >
        {localExpanded ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        {headerLabel}
        {block.isTruncated && !localExpanded && (
          <span className="text-caption opacity-70">
            ({block.fullContentLength} {t.chat.characters})
          </span>
        )}
        {block.type === 'list' && block.parsedItems && (
          <span className="text-caption opacity-70">
            ({block.parsedItems.length})
          </span>
        )}
      </button>

      {/* Expanded content */}
      {localExpanded && (
        <div className={cn(
          'mt-2 rounded-lg overflow-hidden border',
          styles.contentBg,
          styles.borderColor
        )}>
          {renderContent()}
        </div>
      )}
    </div>
  );
}
