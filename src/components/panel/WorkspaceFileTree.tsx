import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  File,
  FileCode,
  FileJson,
  FileText,
  FileImage,
} from 'lucide-react';
import { useI18n, type TranslationDict } from '@/i18n';
import { ScrollArea } from '@/components/ui/scroll-area';
import { usePreviewStore } from '@/stores/previewStore';
import { useWorkspaceTree, type WorkspaceTreeEntry } from '@/hooks/useWorkspaceTree';

// Extension → icon lookup. Deliberately simple (mirrors FilesSection's getFileIcon) —
// this is a lightweight glance at the project, not a full IDE file-type registry.
function getFileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() || '';

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

const INDENT_PX = 14;
const BASE_PADDING_PX = 6;

interface TreeRowProps {
  entry: WorkspaceTreeEntry;
  depth: number;
  childrenByPath: Map<string, WorkspaceTreeEntry[]>;
  expandedPaths: Set<string>;
  loadingPaths: Set<string>;
  errorsByPath: Map<string, string>;
  toggleExpand: (path: string) => void;
  openPreview: (path: string) => void;
  t: TranslationDict;
}

function TreeRow({
  entry,
  depth,
  childrenByPath,
  expandedPaths,
  loadingPaths,
  errorsByPath,
  toggleExpand,
  openPreview,
  t,
}: TreeRowProps) {
  const isExpanded = entry.isDirectory && expandedPaths.has(entry.path);
  const isLoadingChildren = entry.isDirectory && loadingPaths.has(entry.path);
  const childError = entry.isDirectory ? errorsByPath.get(entry.path) : undefined;
  const children = entry.isDirectory ? childrenByPath.get(entry.path) : undefined;
  const Icon = entry.isDirectory ? (isExpanded ? FolderOpen : Folder) : getFileIcon(entry.name);

  const handleActivate = () => {
    if (entry.isDirectory) {
      toggleExpand(entry.path);
    } else {
      openPreview(entry.path);
    }
  };

  const childIndent = (depth + 1) * INDENT_PX + BASE_PADDING_PX;

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        className="group flex items-center gap-1 py-1 rounded-md hover:bg-[var(--abu-bg-muted)] transition-colors cursor-pointer"
        style={{ paddingLeft: depth * INDENT_PX + BASE_PADDING_PX, paddingRight: BASE_PADDING_PX }}
        title={entry.path}
        onClick={handleActivate}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleActivate();
          }
        }}
      >
        {entry.isDirectory ? (
          isExpanded ? (
            <ChevronDown className="w-3 h-3 text-[var(--abu-text-tertiary)] shrink-0" />
          ) : (
            <ChevronRight className="w-3 h-3 text-[var(--abu-text-tertiary)] shrink-0" />
          )
        ) : (
          <span className="w-3 h-3 shrink-0" />
        )}
        <Icon className="w-3.5 h-3.5 text-[var(--abu-text-tertiary)] shrink-0" />
        <span className="text-[12px] truncate flex-1 text-[var(--abu-text-primary)]">{entry.name}</span>
      </div>

      {isExpanded && (
        <div>
          {isLoadingChildren && !children && (
            <div
              style={{ paddingLeft: childIndent }}
              className="text-[11px] text-[var(--abu-text-muted)] py-0.5"
            >
              {t.panel.fileTree.loading}
            </div>
          )}
          {childError && (
            <div
              style={{ paddingLeft: childIndent }}
              className="text-[11px] text-[var(--abu-text-muted)] py-0.5"
            >
              {t.panel.fileTree.loadError}
            </div>
          )}
          {children && children.length === 0 && (
            <div
              style={{ paddingLeft: childIndent }}
              className="text-[11px] text-[var(--abu-text-muted)] py-0.5"
            >
              {t.panel.fileTree.empty}
            </div>
          )}
          {children?.map((child) => (
            <TreeRow
              key={child.path}
              entry={child}
              depth={depth + 1}
              childrenByPath={childrenByPath}
              expandedPaths={expandedPaths}
              loadingPaths={loadingPaths}
              errorsByPath={errorsByPath}
              toggleExpand={toggleExpand}
              openPreview={openPreview}
              t={t}
            />
          ))}
        </div>
      )}
    </>
  );
}

/**
 * Lightweight, lazily-expanding project file tree for the right-side workspace panel.
 * Deliberately NOT an IDE explorer: no context menus, no drag/drop, no multi-select,
 * no create/rename/delete — just browse + click-to-preview.
 */
export default function WorkspaceFileTree() {
  const { t } = useI18n();
  const openPreview = usePreviewStore((s) => s.openPreview);
  const {
    rootPath,
    rootEntries,
    isRootLoading,
    rootError,
    childrenByPath,
    expandedPaths,
    loadingPaths,
    errorsByPath,
    toggleExpand,
  } = useWorkspaceTree();

  return (
    <div className="flex flex-col h-full min-h-0 gap-2 mt-3">
      <div className="flex items-center justify-between shrink-0">
        <h4 className="text-[11px] font-medium text-[var(--abu-text-muted)] uppercase tracking-wider">
          {t.panel.fileTree.title}
        </h4>
      </div>

      {!rootPath ? (
        <p className="text-[12px] text-[var(--abu-text-muted)] py-1">{t.panel.fileTree.noWorkspace}</p>
      ) : rootError ? (
        <p className="text-[12px] text-[var(--abu-text-muted)] py-1">{t.panel.fileTree.loadError}</p>
      ) : isRootLoading && rootEntries.length === 0 ? (
        <p className="text-[12px] text-[var(--abu-text-muted)] py-1">{t.panel.fileTree.loading}</p>
      ) : rootEntries.length === 0 ? (
        <p className="text-[12px] text-[var(--abu-text-muted)] py-1">{t.panel.fileTree.empty}</p>
      ) : (
        <ScrollArea className="flex-1 min-h-0">
          <div className="space-y-0.5 pr-2 pb-2">
            {rootEntries.map((entry) => (
              <TreeRow
                key={entry.path}
                entry={entry}
                depth={0}
                childrenByPath={childrenByPath}
                expandedPaths={expandedPaths}
                loadingPaths={loadingPaths}
                errorsByPath={errorsByPath}
                toggleExpand={toggleExpand}
                openPreview={openPreview}
                t={t}
              />
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
