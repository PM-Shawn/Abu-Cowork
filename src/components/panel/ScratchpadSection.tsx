import { useState } from 'react';
import {
  ChevronDown,
  FileText,
  Image,
  FileCode,
  File,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useActiveConversation } from '@/stores/chatStore';
import {
  useScratchpadStore,
  useScratchpadByConversation,
  type ScratchpadEntry,
} from '@/stores/scratchpadStore';

/**
 * ScratchpadSection - Shows intermediate results from AI processing
 * Simplified design matching Claude Cowork style
 */
export default function ScratchpadSection() {
  const [expanded, setExpanded] = useState(true);
  const conversation = useActiveConversation();
  const entries = useScratchpadByConversation(conversation?.id);

  // Don't render if no entries
  if (entries.length === 0) {
    return null;
  }

  return (
    <div className="scratchpad-section pb-5 border-b border-[var(--abu-border)]">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex items-center justify-between w-full text-left group"
      >
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-[var(--abu-text-tertiary)]" />
          <span className="text-[13px] font-medium text-[var(--abu-text-primary)]">Scratchpad</span>
        </div>
        <ChevronDown
          className={cn(
            'h-4 w-4 text-[var(--abu-text-muted)] transition-transform',
            !expanded && '-rotate-90'
          )}
        />
      </button>

      {/* Entries list - Claude Cowork style */}
      {expanded && (
        <div className="mt-3 space-y-1">
          {entries.slice(0, 5).map((entry) => (
            <ScratchpadEntryRow key={entry.id} entry={entry} />
          ))}
          {entries.length > 5 && (
            <div className="text-[11px] text-[var(--abu-text-muted)] pl-7">
              +{entries.length - 5} more
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- Entry Row (Claude Cowork style) ---

interface ScratchpadEntryRowProps {
  entry: ScratchpadEntry;
}

function ScratchpadEntryRow({ entry }: ScratchpadEntryRowProps) {
  const [showDetail, setShowDetail] = useState(false);
  const markViewed = useScratchpadStore((s) => s.markViewed);

  const handleClick = () => {
    setShowDetail(!showDetail);
    if (!entry.isViewed) {
      markViewed(entry.id);
    }
  };

  // Get file icon based on source file extension or type
  const getFileIcon = () => {
    const ext = entry.sourceFile?.split('.').pop()?.toLowerCase();

    if (ext && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) {
      return <Image className="h-4 w-4 text-[var(--abu-text-muted)]" />;
    }
    if (ext && ['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go'].includes(ext)) {
      return <FileCode className="h-4 w-4 text-[var(--abu-text-muted)]" />;
    }
    if (entry.type === 'search') {
      return <FileText className="h-4 w-4 text-[var(--abu-text-muted)]" />;
    }
    return <File className="h-4 w-4 text-[var(--abu-text-muted)]" />;
  };

  // Get display name
  const getDisplayName = () => {
    if (entry.sourceFile) {
      return entry.sourceFile.split(/[/\\]/).pop() || entry.title;
    }
    return entry.title;
  };

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={handleClick}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), handleClick())}
        className={cn(
          'flex items-center gap-3 py-1.5 px-2 -mx-2 rounded cursor-pointer',
          'hover:bg-[var(--abu-bg-hover)]'
        )}
      >
        {/* File icon */}
        <div className="shrink-0">{getFileIcon()}</div>

        {/* File name */}
        <span className="flex-1 text-[13px] text-[var(--abu-text-tertiary)] truncate">
          {getDisplayName()}
        </span>

        {/* Viewed status */}
        <span className="text-[11px] text-[var(--abu-text-muted)] shrink-0">
          {entry.isViewed ? 'viewed' : 'new'}
        </span>
      </div>

      {/* Expanded detail */}
      {showDetail && (
        <div className="ml-7 mt-1 p-2 bg-[var(--abu-bg-muted)] rounded">
          <div className="font-mono text-[11px] text-[var(--abu-text-tertiary)] break-all max-h-[200px] overflow-y-auto whitespace-pre-wrap">
            {entry.content.length > 1000
              ? entry.content.slice(0, 1000) + '...'
              : entry.content}
          </div>
        </div>
      )}
    </div>
  );
}
