import type { SearchResult } from '@/types';
import { cn } from '@/lib/utils';
import { Link } from '@/components/ds/link';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';

interface SourceCardProps {
  result: SearchResult;
  index: number;
  isHighlighted?: boolean;
}

/** Compact source row — favicon placeholder + title + domain, industry-standard minimal style */
export default function SourceCard({ result, index, isHighlighted }: SourceCardProps) {
  return (
    <Link
      href={result.url}
      target="_blank"
      rel="noopener noreferrer"
      data-source-index={index}
      className={cn(
        'group/source flex w-full items-center gap-2 px-2 py-1 text-left transition-colors duration-fast hover:no-underline',
        isHighlighted ? 'bg-fill-selected' : 'hover:bg-fill-hover',
      )}
    >
      {/* Index number */}
      <span className="w-4 shrink-0 text-right text-caption text-label-tertiary tabular-nums">
        {index}
      </span>

      {/* Favicon placeholder — first letter of the source */}
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-control bg-fill text-caption font-medium uppercase text-label-secondary">
        {(result.source || result.title)?.[0] || '?'}
      </span>

      {/* Title */}
      <span className="min-w-0 flex-1 truncate text-ui group-hover/source:underline">
        {result.title}
      </span>

      {/* Domain */}
      {result.source && (
        <span className="hidden shrink-0 text-caption text-label-tertiary sm:inline">
          {result.source}
        </span>
      )}

      <Icon icon={AppIcons.openExternal} size="sm" className="text-label-tertiary opacity-0 transition-opacity duration-fast group-hover/source:opacity-100" />
    </Link>
  );
}
