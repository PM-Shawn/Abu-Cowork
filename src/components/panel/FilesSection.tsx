import { useActiveConversation } from '@/stores/chatStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useI18n, format as i18nFormat } from '@/i18n';
import { File, FileCode, FileJson, FileText, FileImage, ExternalLink, Undo2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useEffect, useMemo, useState } from 'react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { getBaseName } from '@/utils/pathUtils';
import { extractFileOutputs } from '@/utils/workflowExtractor';
import { resolveFileSource, type ResolvedSource } from '@/core/session/outputSnapshots';
import { runRestoreFlow } from '@/utils/restoreFlow';
import { useFileRefreshStore } from '@/stores/fileRefreshStore';

// Extract file extension and return appropriate icon
function getFileIcon(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() || '';

  if (['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'cpp', 'c', 'h'].includes(ext)) {
    return FileCode;
  }
  if (['json', 'yaml', 'yml', 'toml', 'xml'].includes(ext)) {
    return FileJson;
  }
  if (['md', 'txt', 'log'].includes(ext)) {
    return FileText;
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) {
    return FileImage;
  }
  return File;
}

function getFileName(path: string): string {
  return getBaseName(path);
}

interface TrackedFile {
  path: string;
  operation: 'read' | 'write' | 'create';
  timestamp: number;
}

interface FileCardProps {
  file: TrackedFile;
  conversationId: string | undefined;
  operationLabels: Record<string, string>;
  previewTitle: string;
  finderTitle: string;
  restoreTitle: string;
  fileMissingTitle: string;
}

function FileCard({ file, conversationId, operationLabels, previewTitle, finderTitle, restoreTitle, fileMissingTitle }: FileCardProps) {
  const Icon = getFileIcon(file.path);
  const fileName = getFileName(file.path);
  const openPreview = usePreviewStore((s) => s.openPreview);
  const [resolved, setResolved] = useState<ResolvedSource | null>(null);
  // Subscribe to global refresh tick: any restore (here or elsewhere) re-resolves us.
  const refreshTick = useFileRefreshStore((s) => s.tick);

  // Resolve effective state (live / snapshot / unavailable) so action buttons
  // can switch behavior intelligently.
  useEffect(() => {
    let cancelled = false;
    resolveFileSource(conversationId, file.path)
      .then((r) => { if (!cancelled) setResolved(r); })
      .catch(() => {
        if (!cancelled) setResolved({ status: 'missing', basename: getBaseName(file.path), originalPath: file.path });
      });
    return () => { cancelled = true; };
  }, [file.path, conversationId, refreshTick]);

  const isFromSnapshot = resolved?.status === 'available' && resolved.isFromSnapshot;
  const isUnavailable = resolved?.status === 'missing' || resolved?.status === 'skipped';
  const effectivePath = resolved?.status === 'available' ? resolved.path : null;

  const handleClick = () => {
    if (effectivePath) openPreview(effectivePath);
  };

  const handleAction = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!resolved) return;
    if (resolved.status === 'available' && !resolved.isFromSnapshot) {
      // Live: reveal original in Finder
      try { await revealItemInDir(resolved.path); } catch (err) { console.error(err); }
      return;
    }
    if (resolved.status === 'available' && resolved.isFromSnapshot && conversationId) {
      // Snapshot: restore to original location.
      // runRestoreFlow handles the global refresh signal — no manual tick bump needed.
      await runRestoreFlow(conversationId, file.path);
    }
    // unavailable: nothing to do
  };

  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        'group flex items-center gap-2 px-2 py-1.5 rounded-md bg-[var(--abu-bg-base)] hover:bg-[var(--abu-bg-muted)] transition-colors cursor-pointer',
        file.operation === 'write' && 'ring-1 ring-amber-500/30',
        file.operation === 'create' && 'ring-1 ring-green-500/30',
        isUnavailable && 'opacity-60'
      )}
      title={isUnavailable ? `${fileMissingTitle}: ${file.path}` : `${previewTitle}: ${file.path}`}
      onClick={handleClick}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), handleClick())}
    >
      <Icon className="w-3.5 h-3.5 text-[var(--abu-text-tertiary)] shrink-0" />
      <span className={cn(
        'text-[12px] truncate flex-1',
        isUnavailable ? 'text-[var(--abu-text-muted)] line-through' : 'text-[var(--abu-text-primary)]'
      )}>{fileName}</span>
      <span
        className={cn(
          'text-[9px] px-1 py-0.5 rounded font-medium',
          file.operation === 'read' && 'bg-blue-500/15 text-blue-600',
          file.operation === 'write' && 'bg-amber-500/15 text-amber-600',
          file.operation === 'create' && 'bg-green-500/15 text-green-600'
        )}
      >
        {operationLabels[file.operation]}
      </span>
      {!isUnavailable && (
        <button
          onClick={handleAction}
          className="p-0.5 rounded hover:bg-[var(--abu-bg-hover)] opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
          title={isFromSnapshot ? `${restoreTitle}: ${file.path}` : finderTitle}
        >
          {isFromSnapshot
            ? <Undo2 className="w-3 h-3 text-amber-600" />
            : <ExternalLink className="w-3 h-3 text-[var(--abu-text-muted)]" />}
        </button>
      )}
    </div>
  );
}

// Sort priority: create > write > read, then by timestamp descending
function sortFiles(files: TrackedFile[]): TrackedFile[] {
  const priority: Record<string, number> = { create: 0, write: 1, read: 2 };
  return [...files].sort((a, b) => {
    const pDiff = priority[a.operation] - priority[b.operation];
    if (pDiff !== 0) return pDiff;
    return b.timestamp - a.timestamp;
  });
}

export default function FilesSection() {
  const conversation = useActiveConversation();
  const { t } = useI18n();

  const operationLabels: Record<string, string> = {
    read: t.panel.operationRead,
    write: t.panel.operationModify,
    create: t.panel.operationCreate,
  };

  // Extract file references from tool calls
  const trackedFiles = useMemo(() => {
    if (!conversation) return [];

    const allToolCalls = conversation.messages.flatMap((msg) => msg.toolCalls || []);
    const fileOutputs = extractFileOutputs(allToolCalls, { includeReads: true });

    // Deduplicate: writes/creates override reads
    const fileMap = new Map<string, TrackedFile>();
    fileOutputs.forEach((fo, index) => {
      const existing = fileMap.get(fo.path);
      if (fo.operation === 'read' && existing) return; // reads don't override
      fileMap.set(fo.path, { path: fo.path, operation: fo.operation, timestamp: index });
    });

    return sortFiles(Array.from(fileMap.values()));
  }, [conversation]);

  const MAX_VISIBLE = 7;
  const [expanded, setExpanded] = useState(false);
  const hiddenCount = trackedFiles.length - MAX_VISIBLE;
  const visibleFiles = expanded ? trackedFiles : trackedFiles.slice(0, MAX_VISIBLE);

  // Don't render if no tracked files
  if (trackedFiles.length === 0) return null;

  return (
    <div className="space-y-2 mt-3">
      <div className="flex items-center justify-between">
        <h4 className="text-[11px] font-medium text-[var(--abu-text-muted)] uppercase tracking-wider">
          {t.panel.files}
        </h4>
        <span className="text-[10px] text-[var(--abu-text-muted)]">
          {i18nFormat(t.panel.filesCount, { count: trackedFiles.length })}
        </span>
      </div>

      <div className="space-y-1.5">
        {visibleFiles.map((file) => (
          <FileCard
            key={file.path}
            file={file}
            conversationId={conversation?.id}
            operationLabels={operationLabels}
            previewTitle={t.panel.clickToPreview}
            finderTitle={t.panel.showInFinderButton}
            restoreTitle={t.chat.restoreToOriginal}
            fileMissingTitle={t.chat.fileMissing}
          />
        ))}
        {hiddenCount > 0 && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="w-full text-center text-[11px] text-[var(--abu-text-muted)] hover:text-[var(--abu-text-tertiary)] py-1 transition-colors"
          >
            {expanded ? t.panel.collapse : i18nFormat(t.panel.moreFiles, { count: hiddenCount })}
          </button>
        )}
      </div>
    </div>
  );
}
