import { useState, useEffect } from 'react';
import { Globe, ChevronDown, ChevronUp } from 'lucide-react';
import type { SearchResult } from '@/types';
import { useI18n } from '@/i18n';
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
    <div className="my-1.5">
      {/* Collapsible header — like Claude's "Searched the web" */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 px-1 py-1 text-[12px] text-[var(--abu-text-muted)] hover:text-[var(--abu-text-tertiary)] transition-colors"
      >
        <Globe className="h-3 w-3" />
        <span>{t.chat.sources}</span>
        <span className="text-[var(--abu-text-muted)]">{results.length}</span>
        {expanded ? (
          <ChevronUp className="h-3 w-3 ml-0.5" />
        ) : (
          <ChevronDown className="h-3 w-3 ml-0.5" />
        )}
      </button>

      {/* Source list — compact rows, shown when expanded */}
      {expanded && (
        <div className="mt-0.5 space-y-0">
          {results.map((result, index) => (
            <SourceCard key={result.url} result={result} index={index + 1} isHighlighted={highlightedIndex === index + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
