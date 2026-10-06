import { useState, useMemo, useEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Link } from '@/components/ds/link';
import { Pressable } from '@/components/ds/pressable';
import { Spinner } from '@/components/ds/spinner';
import { StatusIcon } from '@/components/ds/status-icon';
import { useI18n, format } from '@/i18n';
import { getDetailBlockLabel } from '@/utils/toolLabels';
import type { DetailBlock } from '@/types/execution';
import { useChatStore } from '@/stores/chatStore';
import { useImageLightboxStore } from '@/stores/imageLightboxStore';
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
  const [outputRefSrc, setOutputRefSrc] = useState<string | null>(null);
  // The file `outputRefSrc` was read from.
  const outputRefPathRef = useRef<string | null>(null);
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
    outputRefPathRef.current = null;
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
        outputRefPathRef.current = resolved.path;
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
        <div className="border-b border-separator px-3 py-1 text-caption text-label-tertiary">
          {block.language}
        </div>
      )}

      {/* Content area */}
      <pre className={cn(
        'px-3 py-2 font-code text-mono whitespace-pre-wrap break-all overflow-x-auto max-h-[300px] overflow-y-auto',
        block.type === 'error' ? 'text-danger' : 'text-label'
      )}>
        {block.content}
      </pre>

      {/* Load more button */}
      {block.isTruncated && onLoadMore && (
        <div className="border-t border-separator px-3 py-2">
          <Button variant="plain" size="sm" onClick={onLoadMore}>
            {t.chat.viewMore} ({(block.fullContentLength || 0) - block.content.length} {t.chat.characters})
          </Button>
        </div>
      )}
    </>
  );

  // Render image content (from read_file images, screenshots)
  const renderImageContent = () => {
    const filename = outputRef?.basename || block.content || t.chat.imageExpired;
    const size = formatImageSize(outputRef?.sizeBytes);
    const metadata = size ? `${filename} · ${size}` : filename;

    // The app's image viewer shows it enlarged. A saved image goes there as the very file this
    // block read: the viewer finds files by name, and two tool images can share one name.
    const openInViewer = (thumbnail: HTMLElement) => {
      if (!block.imageData) return;
      useImageLightboxStore.getState().open([{
        id: outputRef?.relPath ?? block.id,
        mediaType: block.imageData.mediaType,
        data: block.imageData.base64 ?? '',
        filePath: outputRefPathRef.current ?? undefined,
        conversationId: activeConversationId ?? undefined,
      }], 0, thumbnail);
    };

    const frameClass = 'relative group flex h-[200px] w-[320px] items-center justify-center overflow-hidden rounded-control border border-separator bg-fill';
    const renderImageFrame = (children: ReactNode, interactive: boolean) => (
      <div className="p-2">
        {interactive ? (
          <Pressable className={cn(frameClass, 'cursor-pointer')} onClick={(event) => openInViewer(event.currentTarget)}>
            {children}
            <span className="absolute inset-0 flex items-center justify-center transition-colors group-hover:bg-scrim group-focus-visible:bg-scrim">
              <span className="rounded-control bg-raised p-1 text-label opacity-0 shadow-float transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                <Icon icon={AppIcons.enlarge} size="md" />
              </span>
            </span>
          </Pressable>
        ) : (
          <div className={frameClass}>{children}</div>
        )}
        <div className="mt-1 max-w-[320px] truncate text-caption text-label-tertiary">{metadata}</div>
      </div>
    );

    if (!imageSrc) {
      if (outputRef?.relPath && outputRefState === 'loading') {
        return renderImageFrame(
          <Spinner size="sm" labelHidden label={t.chat.imageLoading} />,
          false,
        );
      }
      return renderImageFrame(
        <div className="flex flex-col items-center gap-2 px-4 text-center">
          <Icon icon={AppIcons.imageMissing} size="lg" className="text-label-tertiary" />
          <div className="text-caption text-label-tertiary">{t.chat.imageUnavailable}</div>
          {outputRef?.relPath && (
            <Button
              variant="plain"
              size="sm"
              icon={AppIcons.retry}
              onClick={(e) => {
                e.stopPropagation();
                setRetryNonce((value) => value + 1);
              }}
            >
              {t.chat.imageRetry}
            </Button>
          )}
        </div>,
        false,
      );
    }

    return renderImageFrame(
      <img
        src={imageSrc}
        alt={block.content || 'Image'}
        className="max-w-full max-h-full object-contain"
      />,
      true,
    );
  };

  // Render list content (e.g., search results)
  const renderListContent = () => {
    if (!block.parsedItems || block.parsedItems.length === 0) {
      return renderTextContent();
    }

    return (
      <div className="divide-y divide-separator">
        {block.parsedItems.slice(0, 5).map((item, index) => (
          <div key={index} className="px-3 py-2 transition-colors hover:bg-fill-hover">
            <div className="flex items-start gap-2">
              {item.icon && <span className="text-ui-sm">{item.icon}</span>}
              <div className="flex-1 min-w-0">
                {item.url ? (
                  <Link
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-ui-sm font-medium"
                  >
                    {item.title}
                    <Icon icon={AppIcons.openExternal} size="sm" />
                  </Link>
                ) : (
                  <div className="text-ui-sm font-medium text-label">{item.title}</div>
                )}
                {item.description && (
                  <div className="mt-1 line-clamp-2 text-caption text-label-tertiary">
                    {item.description}
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
        {block.parsedItems.length > 5 && (
          <div className="px-3 py-2 text-caption text-label-tertiary">
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
      <pre className="px-3 py-2 font-code text-mono text-label whitespace-pre-wrap break-all overflow-x-auto max-h-[300px] overflow-y-auto">
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
        <table className="w-full text-ui-sm">
          <thead>
            <tr className="bg-fill">
              {headers.map((header, i) => (
                <th key={i} className="border-b border-separator px-3 py-1 text-left font-medium text-label">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 10).map((row, i) => (
              <tr key={i} className="hover:bg-fill-hover">
                {row.map((cell, j) => (
                  <td key={j} className="border-b border-separator px-3 py-1 text-label">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > 10 && (
          <div className="border-t border-separator px-3 py-2 text-caption text-label-tertiary">
            {format(t.chat.moreRows, { count: rows.length - 10 })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="mt-1">
      {/* Label button */}
      <Pressable
        onClick={handleToggle}
        aria-expanded={localExpanded}
        className="inline-flex h-5 items-center gap-1 rounded-control bg-fill px-2 text-caption text-label-secondary transition-colors hover:bg-fill-hover"
      >
        <Icon icon={localExpanded ? AppIcons.expand : AppIcons.disclose} size="sm" />
        {block.type === 'error' && <StatusIcon tone="danger" size="sm" />}
        {headerLabel}
        {block.isTruncated && !localExpanded && (
          <span className="text-label-tertiary">
            ({block.fullContentLength} {t.chat.characters})
          </span>
        )}
        {block.type === 'list' && block.parsedItems && (
          <span className="text-label-tertiary">
            ({block.parsedItems.length})
          </span>
        )}
      </Pressable>

      {/* Expanded content */}
      {localExpanded && (
        <div className="mt-2 overflow-hidden rounded-panel bg-code">
          {renderContent()}
        </div>
      )}
    </div>
  );
}
