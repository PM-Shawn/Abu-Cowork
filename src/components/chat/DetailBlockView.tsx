import { useState, useMemo, useEffect } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, Maximize2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import type { DetailBlock } from '@/types/execution';

interface DetailBlockViewProps {
  block: DetailBlock;
  onToggle: () => void;
  onLoadMore?: () => void;
}

/**
 * DetailBlockView - Collapsible content area for tool input/output
 * Supports multiple types: script, result, error, list, json, diff, table
 * Uses local state for toggle with optional store sync via onToggle.
 */
export default function DetailBlockView({ block, onToggle, onLoadMore }: DetailBlockViewProps) {
  const { locale } = useI18n();
  // Local expanded state — syncs with block.isExpanded from store when available
  const [localExpanded, setLocalExpanded] = useState(block.isExpanded);
  const [imageFullscreen, setImageFullscreen] = useState(false);

  // Sync from external state changes (e.g. store updates during live execution)
  useEffect(() => {
    setLocalExpanded(block.isExpanded);
  }, [block.isExpanded]);

  const handleToggle = () => {
    setLocalExpanded((prev) => !prev);
    onToggle(); // Also try store update (may be no-op for persisted snapshots)
  };
  const isZh = locale.startsWith('zh');

  // Style based on block type
  const styles = useMemo(() => {
    switch (block.type) {
      case 'error':
        return {
          labelBg: 'bg-red-100',
          labelText: 'text-red-600',
          contentBg: 'bg-red-50',
          borderColor: 'border-red-200',
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
          labelBg: 'bg-blue-50',
          labelText: 'text-blue-600',
          contentBg: 'bg-blue-50/50',
          borderColor: 'border-blue-100',
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
          labelBg: 'bg-emerald-50',
          labelText: 'text-emerald-600',
          contentBg: 'bg-[var(--abu-bg-base)]',
          borderColor: 'border-emerald-100',
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
        <div className="px-3 py-1.5 text-[11px] text-[var(--abu-text-muted)] bg-[var(--abu-bg-hover)] border-b border-[var(--abu-bg-hover)]">
          {block.language}
        </div>
      )}

      {/* Content area */}
      <pre className={cn(
        'px-3 py-2 text-[12px] font-mono whitespace-pre-wrap break-all overflow-x-auto max-h-[300px] overflow-y-auto',
        block.type === 'error' ? 'text-red-600' : 'text-[var(--abu-text-tertiary)]'
      )}>
        {block.content}
      </pre>

      {/* Load more button */}
      {block.isTruncated && onLoadMore && (
        <div className="px-3 py-2 border-t border-[var(--abu-bg-hover)]">
          <button
            onClick={onLoadMore}
            className="text-[11px] text-[var(--abu-clay)] hover:underline"
          >
            {isZh ? '查看更多' : 'Show more'} ({(block.fullContentLength || 0) - block.content.length} {isZh ? '字符' : 'chars'})
          </button>
        </div>
      )}
    </>
  );

  // Render image content (from read_file images, screenshots)
  const renderImageContent = () => {
    if (!block.imageData) return renderTextContent();
    const src = `data:${block.imageData.mediaType};base64,${block.imageData.base64}`;
    return (
      <>
        <div className="p-2">
          <div
            className="relative group cursor-pointer inline-block"
            onClick={() => setImageFullscreen(true)}
          >
            <img
              src={src}
              alt={block.content || 'Image'}
              className="rounded border border-[var(--abu-bg-hover)] max-w-[320px] max-h-[200px] object-contain"
            />
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors rounded flex items-center justify-center">
              <Maximize2 className="h-5 w-5 text-white opacity-0 group-hover:opacity-80 transition-opacity" />
            </div>
          </div>
          <div className="mt-1 text-[11px] text-[var(--abu-text-muted)]">{block.content}</div>
        </div>
        {imageFullscreen && (
          <div
            className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-8 cursor-pointer"
            onClick={() => setImageFullscreen(false)}
          >
            <img
              src={src}
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
              {item.icon && <span className="text-sm">{item.icon}</span>}
              <div className="flex-1 min-w-0">
                {item.url ? (
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[13px] text-[var(--abu-text-tertiary)] hover:text-[var(--abu-clay)] font-medium flex items-center gap-1"
                  >
                    {item.title}
                    <ExternalLink className="h-3 w-3 opacity-50" />
                  </a>
                ) : (
                  <div className="text-[13px] text-[var(--abu-text-tertiary)] font-medium">{item.title}</div>
                )}
                {item.description && (
                  <div className="text-[11px] text-[var(--abu-text-muted)] mt-0.5 line-clamp-2">
                    {item.description}
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
        {block.parsedItems.length > 5 && (
          <div className="px-3 py-2 text-[11px] text-[var(--abu-text-muted)]">
            {isZh ? `还有 ${block.parsedItems.length - 5} 项...` : `${block.parsedItems.length - 5} more items...`}
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
      <pre className="px-3 py-2 text-[12px] text-[var(--abu-text-tertiary)] font-mono whitespace-pre-wrap break-all overflow-x-auto max-h-[300px] overflow-y-auto">
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
        <table className="w-full text-[12px]">
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
          <div className="px-3 py-2 text-[11px] text-[var(--abu-text-muted)] border-t border-[var(--abu-bg-hover)]">
            {isZh ? `还有 ${rows.length - 10} 行...` : `${rows.length - 10} more rows...`}
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
          'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px]',
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
        {block.label}
        {block.isTruncated && !localExpanded && (
          <span className="text-[10px] opacity-70">
            ({block.fullContentLength} {isZh ? '字符' : 'chars'})
          </span>
        )}
        {block.type === 'list' && block.parsedItems && (
          <span className="text-[10px] opacity-70">
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
