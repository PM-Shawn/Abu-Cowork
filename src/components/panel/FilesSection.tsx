import { useChatStore } from '@/stores/chatStore';
import { useActiveToolCallLists } from './useActiveToolCallLists';
import { usePreviewStore } from '@/stores/previewStore';
import { useI18n, format as i18nFormat } from '@/i18n';
import { Button, IconButton } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Pressable } from '@/components/ds/pressable';
import { Tag } from '@/components/ds/tag';
import { cn } from '@/lib/utils';
import { memo, useEffect, useMemo, useState } from 'react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { getBaseName } from '@/utils/pathUtils';
import { extractFileOutputs } from '@/utils/workflowExtractor';
import { resolveFileSource, type ResolvedSource } from '@/core/session/outputSnapshots';

// Extract file extension and return appropriate icon
function getFileIcon(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() || '';

  if (['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'cpp', 'c', 'h'].includes(ext)) {
    return AppIcons.fileCode;
  }
  if (['json', 'yaml', 'yml', 'toml', 'xml'].includes(ext)) {
    return AppIcons.fileJson;
  }
  if (['md', 'txt', 'log'].includes(ext)) {
    return AppIcons.file;
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) {
    return AppIcons.fileImage;
  }
  return AppIcons.fileGeneric;
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
  path: string;
  operation: TrackedFile['operation'];
  conversationId: string | undefined;
  operationLabel: string;
  previewTitle: string;
  finderTitle: string;
  fileMissingTitle: string;
}

// The row holds a tooltip button, so it is memoized and takes plain strings only:
// a render of FilesSection (one more file, a new label) leaves the other rows alone.
const FileCard = memo(function FileCard({ path, operation, conversationId, operationLabel, previewTitle, finderTitle, fileMissingTitle }: FileCardProps) {
  const fileName = getFileName(path);
  const openPreview = usePreviewStore((s) => s.openPreview);
  const [resolved, setResolved] = useState<ResolvedSource | null>(null);

  // Resolve effective state (live / snapshot / unavailable) so action buttons
  // can switch behavior intelligently.
  useEffect(() => {
    let cancelled = false;
    resolveFileSource(conversationId, path)
      .then((r) => { if (!cancelled) setResolved(r); })
      .catch(() => {
        if (!cancelled) setResolved({ status: 'missing', basename: getBaseName(path), originalPath: path });
      });
    return () => { cancelled = true; };
  }, [path, conversationId]);

  const isUnavailable = resolved?.status === 'missing' || resolved?.status === 'skipped';
  const effectivePath = resolved?.status === 'available' ? resolved.path : null;

  const handleClick = () => {
    if (effectivePath) openPreview(effectivePath);
  };

  const handleReveal = async () => {
    if (!effectivePath) return;
    try { await revealItemInDir(effectivePath); } catch (err) { console.error(err); }
  };

  return (
    <div className={cn('group flex items-center rounded-control hover:bg-fill-hover', isUnavailable && 'opacity-60')}>
      <Pressable
        title={isUnavailable ? `${fileMissingTitle}: ${path}` : `${previewTitle}: ${path}`}
        onClick={handleClick}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left"
      >
        <Icon icon={getFileIcon(path)} size="sm" className="text-label-tertiary" />
        <span className={cn(
          'min-w-0 flex-1 truncate text-ui',
          isUnavailable
            ? operation === 'read'
              ? 'text-label-tertiary'              // read: dim only, no strikethrough
              : 'text-label-tertiary line-through' // write/create: strikethrough = artifact lost
            : 'text-label'
        )}>{fileName}</span>
        <Tag>{operationLabel}</Tag>
      </Pressable>
      {isUnavailable ? (
        // Keeps the operation tags of every row in one column.
        <span className="h-6 w-6 shrink-0" />
      ) : (
        <IconButton
          size="sm"
          icon={AppIcons.folderOpen}
          label={finderTitle}
          onClick={handleReveal}
          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        />
      )}
    </div>
  );
});

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
  // Only the id and the tool calls: text streaming into a message changes neither,
  // so the section and its file list stay as they are for every streamed character.
  const conversationId = useChatStore((s) => s.activeConversationId ?? undefined);
  const toolCallLists = useActiveToolCallLists();
  const { t } = useI18n();

  const operationLabels: Record<string, string> = {
    read: t.panel.operationRead,
    write: t.panel.operationModify,
    create: t.panel.operationCreate,
  };

  // Extract file references from tool calls — file-ops semantics: show every
  // file the conversation touched, not just deliverables. extractFileOutputs
  // (file-ops mode) skips DOCUMENT_EXTENSIONS whitelist, includes reads, keeps
  // executed scripts, and only filters obvious noise (NOISE_EXTENSIONS).
  const trackedFiles = useMemo(() => {
    const allToolCalls = toolCallLists.flatMap((toolCalls) => toolCalls || []);
    const fileOutputs = extractFileOutputs(allToolCalls, { mode: 'file-ops' });

    // extractFileOutputs already dedupes by path (and upgrades read→write
    // when both happen on the same path). The local dedup below is redundant
    // but kept as a defensive last line + to attach a stable timestamp/index.
    const fileMap = new Map<string, TrackedFile>();
    fileOutputs.forEach((fo, index) => {
      const existing = fileMap.get(fo.path);
      if (fo.operation === 'read' && existing) return;
      fileMap.set(fo.path, { path: fo.path, operation: fo.operation, timestamp: index });
    });

    return sortFiles(Array.from(fileMap.values()));
  }, [toolCallLists]);

  const MAX_VISIBLE = 7;
  const [expanded, setExpanded] = useState(false);
  const hiddenCount = trackedFiles.length - MAX_VISIBLE;
  const visibleFiles = expanded ? trackedFiles : trackedFiles.slice(0, MAX_VISIBLE);

  // Don't render if no tracked files
  if (trackedFiles.length === 0) return null;

  return (
    <div className="mt-3 space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-ui-sm font-medium text-label-tertiary">
          {t.panel.files}
        </h4>
        <span className="text-caption text-label-tertiary">
          {i18nFormat(t.panel.filesCount, { count: trackedFiles.length })}
        </span>
      </div>

      <div className="space-y-1">
        {visibleFiles.map((file) => (
          <FileCard
            key={file.path}
            path={file.path}
            operation={file.operation}
            conversationId={conversationId}
            operationLabel={operationLabels[file.operation]}
            previewTitle={t.panel.clickToPreview}
            finderTitle={t.panel.showInFinderButton}
            fileMissingTitle={t.chat.fileMissing}
          />
        ))}
        {hiddenCount > 0 && (
          <div className="flex justify-center">
            <Button variant="plain" size="sm" onClick={() => setExpanded(!expanded)}>
              {expanded ? t.panel.collapse : i18nFormat(t.panel.moreFiles, { count: hiddenCount })}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
