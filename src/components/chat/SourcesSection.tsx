import { useState, useEffect } from 'react';
import type { SearchResult } from '@/types';
import { useI18n } from '@/i18n';
import { Pressable } from '@/components/ds/pressable';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import SourceCard from './SourceCard';

interface SourcesSectionProps {
  results: SearchResult[];
  highlightedIndex?: number | null;
}

export default function SourcesSection({ results, highlightedIndex }: SourcesSectionProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);

  // Auto-expand when a citation is clicked
  useEffect(() => {
    if (highlightedIndex != null) {
      setExpanded(true);
    }
  }, [highlightedIndex]);

  if (results.length === 0) return null;

  return (
    <div className="my-2">
      {/* Collapsible header — like Claude's "Searched the web" */}
      <Pressable
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 rounded-control px-1 py-1 text-ui-sm text-label-tertiary transition-colors duration-fast hover:text-label-secondary"
      >
        <Icon icon={AppIcons.webPage} size="sm" />
        <span>{t.chat.sources}</span>
        <span>{results.length}</span>
        <Icon icon={expanded ? AppIcons.collapse : AppIcons.expand} size="sm" />
      </Pressable>

      {/* Source list — compact rows, shown when expanded */}
      {expanded && (
        <div className="mt-1">
          {results.map((result, index) => (
            <SourceCard key={result.url} result={result} index={index + 1} isHighlighted={highlightedIndex === index + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
