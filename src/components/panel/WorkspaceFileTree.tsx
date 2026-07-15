import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
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
  MoreHorizontal,
  FolderPlus,
  FilePlus,
  ExternalLink,
  Paperclip,
  Copy,
  Pencil,
  Trash2,
} from 'lucide-react';
import { mkdir, copyFile, rename, writeTextFile, exists } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { useI18n, type TranslationDict } from '@/i18n';
import { ScrollArea } from '@/components/ui/scroll-area';
import { usePreviewStore } from '@/stores/previewStore';
import { useToastStore } from '@/stores/toastStore';
import { useChatStore } from '@/stores/chatStore';
import { useWorkspaceTree, type WorkspaceTreeEntry } from '@/hooks/useWorkspaceTree';
import { joinPath, getBaseName, getParentDir, normalizeSeparators } from '@/utils/pathUtils';

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

/**
 * Resolve a destination path under `dir` for `fileName` that doesn't already
 * exist, appending " (1)", " (2)", … before the extension on collision. Guards
 * "Add file" against Tauri's copyFile silently overwriting an existing file.
 */
async function nonCollidingPath(dir: string, fileName: string): Promise<string> {
  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : '';
  let candidate = joinPath(dir, fileName);
  for (let n = 1; await exists(candidate); n++) {
    candidate = joinPath(dir, `${stem} (${n})${ext}`);
  }
  return candidate;
}

/**
 * Minimal reusable inline text input for the tree's "type a name" interactions
 * (rename, new file, new folder — both the per-row context menu and the
 * header's "..." menu). Caller supplies layout (icon/indentation) around it;
 * this only owns the value + commit/cancel keyboard behavior. autoFocus +
 * onBlur-submits + Enter/Escape mirrors the pre-existing header new-folder
 * input and Sidebar's inline conversation rename.
 */
function InlineNameInput({
  initialValue = '',
  placeholder,
  onSubmit,
  onCancel,
}: {
  initialValue?: string;
  placeholder?: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  // Fire commit/cancel at most once: Enter commits then unmounts the input, and
  // a trailing blur (or a blur racing an Escape) must not re-run onSubmit against
  // the already-renamed/removed path.
  const settled = useRef(false);
  const submit = (v: string) => { if (settled.current) return; settled.current = true; onSubmit(v); };
  const cancel = () => { if (settled.current) return; settled.current = true; onCancel(); };
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => submit(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); submit(value); }
        if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      }}
      onClick={(e) => e.stopPropagation()}
      placeholder={placeholder}
      className="flex-1 min-w-0 text-[12px] bg-transparent border-b border-[var(--abu-clay)] outline-none text-[var(--abu-text-primary)]"
    />
  );
}

interface TreeRowProps {
  entry: WorkspaceTreeEntry;
  depth: number;
  childrenByPath: Map<string, WorkspaceTreeEntry[]>;
  expandedPaths: Set<string>;
  loadingPaths: Set<string>;
  errorsByPath: Map<string, string>;
  toggleExpand: (path: string) => void;
  openPreview: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, entry: WorkspaceTreeEntry) => void;
  renamingPath: string | null;
  onRenameSubmit: (entry: WorkspaceTreeEntry, name: string) => void;
  onRenameCancel: () => void;
  creatingInFolder: { folderPath: string; kind: 'file' | 'folder' } | null;
  onCreateSubmit: (folderPath: string, kind: 'file' | 'folder', name: string) => void;
  onCreateCancel: () => void;
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
  onContextMenu,
  renamingPath,
  onRenameSubmit,
  onRenameCancel,
  creatingInFolder,
  onCreateSubmit,
  onCreateCancel,
  t,
}: TreeRowProps) {
  const isExpanded = entry.isDirectory && expandedPaths.has(entry.path);
  const isLoadingChildren = entry.isDirectory && loadingPaths.has(entry.path);
  const childError = entry.isDirectory ? errorsByPath.get(entry.path) : undefined;
  const children = entry.isDirectory ? childrenByPath.get(entry.path) : undefined;
  const Icon = entry.isDirectory ? (isExpanded ? FolderOpen : Folder) : getFileIcon(entry.name);
  const isRenaming = renamingPath === entry.path;
  const isCreatingHere = entry.isDirectory && creatingInFolder?.folderPath === entry.path;

  const handleActivate = () => {
    if (entry.isDirectory) {
      toggleExpand(entry.path);
    } else {
      openPreview(entry.path);
    }
  };

  const childIndent = (depth + 1) * INDENT_PX + BASE_PADDING_PX;
  const rowIndent = depth * INDENT_PX + BASE_PADDING_PX;

  return (
    <>
      <div
        role={isRenaming ? undefined : 'button'}
        tabIndex={isRenaming ? undefined : 0}
        className="group flex items-center gap-1 py-1 rounded-md hover:bg-[var(--abu-bg-muted)] transition-colors cursor-pointer"
        style={{ paddingLeft: rowIndent, paddingRight: BASE_PADDING_PX }}
        title={isRenaming ? undefined : entry.path}
        onClick={isRenaming ? undefined : handleActivate}
        onContextMenu={isRenaming ? undefined : (e) => onContextMenu(e, entry)}
        onKeyDown={isRenaming ? undefined : (e) => {
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
        {isRenaming ? (
          <InlineNameInput
            initialValue={entry.name}
            onSubmit={(name) => onRenameSubmit(entry, name)}
            onCancel={onRenameCancel}
          />
        ) : (
          <span className="text-[12px] truncate flex-1 text-[var(--abu-text-primary)]">{entry.name}</span>
        )}
      </div>

      {isExpanded && (
        <div>
          {isCreatingHere && creatingInFolder && (
            <div style={{ paddingLeft: childIndent }} className="flex items-center gap-1.5 py-1 pr-1.5">
              {creatingInFolder.kind === 'folder' ? (
                <FolderPlus className="h-3.5 w-3.5 text-[var(--abu-text-muted)] shrink-0" />
              ) : (
                <FilePlus className="h-3.5 w-3.5 text-[var(--abu-text-muted)] shrink-0" />
              )}
              <InlineNameInput
                placeholder={
                  creatingInFolder.kind === 'folder'
                    ? t.panel.fileTree.newFolderPlaceholder
                    : t.panel.fileTree.newFilePlaceholder
                }
                onSubmit={(name) => onCreateSubmit(entry.path, creatingInFolder.kind, name)}
                onCancel={onCreateCancel}
              />
            </div>
          )}
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
              onContextMenu={onContextMenu}
              renamingPath={renamingPath}
              onRenameSubmit={onRenameSubmit}
              onRenameCancel={onRenameCancel}
              creatingInFolder={creatingInFolder}
              onCreateSubmit={onCreateSubmit}
              onCreateCancel={onCreateCancel}
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
 * Deliberately NOT a full IDE explorer: no drag/drop, no multi-select — but each row
 * does support a right-click context menu (reveal in Finder / add to chat / copy path /
 * rename / delete / new file & folder inside a directory), mirroring TRAE Work.
 */
export default function WorkspaceFileTree() {
  const { t } = useI18n();
  const openPreview = usePreviewStore((s) => s.openPreview);
  const {
    rootPath,
    rootEntries,
    isRootLoading,
    rootError,
    rootMissing,
    childrenByPath,
    expandedPaths,
    loadingPaths,
    errorsByPath,
    toggleExpand,
    refresh,
  } = useWorkspaceTree();

  // Header "more actions" menu (new folder / add file / refresh) — TRAE-style.
  // New items land in the workspace root; the fs-watch auto-refresh + manual
  // refresh keep the tree in sync.
  const [menuOpen, setMenuOpen] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const timer = setTimeout(() => document.addEventListener('mousedown', onClick), 0);
    return () => { clearTimeout(timer); document.removeEventListener('mousedown', onClick); };
  }, [menuOpen]);


  const handleNewFolder = () => {
    setMenuOpen(false);
    setCreatingFolder(true);
  };

  const submitNewFolder = async (rawName: string) => {
    setCreatingFolder(false);
    const name = rawName.trim();
    if (!name || !rootPath) return;
    const target = joinPath(rootPath, name);
    try {
      // mkdir(recursive:true) silently succeeds on an existing dir — check first
      // so a same-name folder gives feedback instead of a no-op.
      if (await exists(target)) {
        useToastStore.getState().addToast({
          type: 'error', title: t.panel.fileTree.newFolderFailed, message: t.panel.fileTree.alreadyExists,
        });
        return;
      }
      await mkdir(target, { recursive: true });
      refresh();
    } catch (err) {
      useToastStore.getState().addToast({
        type: 'error',
        title: t.panel.fileTree.newFolderFailed,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleAddFile = async () => {
    setMenuOpen(false);
    if (!rootPath) return;
    try {
      const selected = await openFileDialog({ multiple: true });
      if (!selected) return;
      const files = Array.isArray(selected) ? selected : [selected];
      for (const src of files) {
        // Tauri's copyFile overwrites the destination silently. Never clobber an
        // existing same-named file — pick a non-colliding "name (n).ext" instead.
        const dest = await nonCollidingPath(rootPath, getBaseName(src));
        await copyFile(src, dest);
      }
      refresh();
    } catch (err) {
      useToastStore.getState().addToast({
        type: 'error',
        title: t.panel.fileTree.addFileFailed,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // ── Per-node context menu (right-click) ──────────────────────────────
  // Single fixed-position menu shared by every row (not one per row) —
  // avoids z-index/clipping fights with the ScrollArea. Mirrors Sidebar's
  // conversation context menu: state {x,y,entry} + useLayoutEffect clamp +
  // outside-click-closes via a document listener.
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: WorkspaceTreeEntry } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [creatingInFolder, setCreatingInFolder] = useState<{ folderPath: string; kind: 'file' | 'folder' } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  const handleRowContextMenu = useCallback((e: React.MouseEvent, entry: WorkspaceTreeEntry) => {
    e.preventDefault();
    e.stopPropagation();
    setConfirmingDelete(false);
    setContextMenu({ x: e.clientX, y: e.clientY, entry });
  }, []);

  // Close on any outside click (mirrors Sidebar: React's synthetic onClick on
  // menu buttons fires first during bubbling since it's delegated closer to
  // the DOM node than this document-level listener, so button actions still run)
  // or Escape.
  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = () => { setContextMenu(null); setConfirmingDelete(false); };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setContextMenu(null); setConfirmingDelete(false); }
    };
    document.addEventListener('click', handleClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('click', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [contextMenu]);

  // Clamp context menu inside viewport once its real size is known (re-clamp
  // when swapping to the smaller delete-confirm view too).
  useLayoutEffect(() => {
    if (!contextMenu) return;
    const el = contextMenuRef.current;
    if (!el) return;
    const margin = 8;
    const rect = el.getBoundingClientRect();
    const overflowX = rect.right - (window.innerWidth - margin);
    const overflowY = rect.bottom - (window.innerHeight - margin);
    if (overflowX <= 0 && overflowY <= 0) return;
    setContextMenu((prev) => prev && {
      ...prev,
      x: Math.max(margin, prev.x - Math.max(0, overflowX)),
      y: Math.max(margin, prev.y - Math.max(0, overflowY)),
    });
  }, [contextMenu, confirmingDelete]);

  const handleRevealInFinder = async (entry: WorkspaceTreeEntry) => {
    setContextMenu(null);
    try {
      await revealItemInDir(entry.path);
    } catch (err) {
      console.error('[WorkspaceFileTree] revealItemInDir failed:', err);
    }
  };

  // "Add to chat" — pushes the path into chatStore's pendingAttachmentPaths
  // ephemeral buffer; ChatInput drains it into its local files/images
  // attachment state (same mechanism used for doc-preview pendingReferences).
  const handleAddToChat = (entry: WorkspaceTreeEntry) => {
    setContextMenu(null);
    useChatStore.getState().addPendingAttachment(entry.path);
    useToastStore.getState().addToast({ type: 'success', title: t.panel.fileTree.addedToChat });
  };

  const handleCopyPath = async (entry: WorkspaceTreeEntry) => {
    setContextMenu(null);
    try {
      await navigator.clipboard.writeText(entry.path);
      useToastStore.getState().addToast({ type: 'success', title: t.panel.fileTree.copyPathDone });
    } catch (err) {
      console.error('[WorkspaceFileTree] clipboard write failed:', err);
    }
  };

  const handleStartRename = (entry: WorkspaceTreeEntry) => {
    setContextMenu(null);
    setRenamingPath(entry.path);
  };

  const handleRenameSubmit = async (entry: WorkspaceTreeEntry, rawName: string) => {
    setRenamingPath(null);
    const name = rawName.trim();
    if (name === entry.name) return; // unchanged — silent no-op, matches Sidebar's rename behavior
    if (!name || name.includes('/')) {
      useToastStore.getState().addToast({
        type: 'error',
        title: t.panel.fileTree.renameFailed,
        message: t.panel.fileTree.invalidName,
      });
      return;
    }
    const newPath = joinPath(getParentDir(entry.path), name);
    try {
      await rename(entry.path, newPath);
      // Follow the rename in the preview: if the open file *is* the renamed
      // entry, re-point it to the new path; if it lives *under* a renamed
      // folder, re-point by swapping the path prefix. Otherwise the preview
      // stays pinned to a now-missing path and shows a broken/stale render.
      const previewed = usePreviewStore.getState().previewFilePath;
      if (previewed === entry.path) {
        openPreview(newPath);
      } else if (previewed && previewed.startsWith(entry.path + '/')) {
        openPreview(newPath + previewed.slice(entry.path.length));
      }
      refresh();
    } catch (err) {
      useToastStore.getState().addToast({
        type: 'error',
        title: t.panel.fileTree.renameFailed,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleStartCreateInFolder = (entry: WorkspaceTreeEntry, kind: 'file' | 'folder') => {
    setContextMenu(null);
    if (!expandedPaths.has(entry.path)) toggleExpand(entry.path);
    setCreatingInFolder({ folderPath: entry.path, kind });
  };

  const handleCreateSubmit = async (folderPath: string, kind: 'file' | 'folder', rawName: string) => {
    setCreatingInFolder(null);
    const name = rawName.trim();
    const failTitle = kind === 'folder' ? t.panel.fileTree.newFolderFailed : t.panel.fileTree.newFileFailed;
    if (!name || name.includes('/')) {
      useToastStore.getState().addToast({ type: 'error', title: failTitle, message: t.panel.fileTree.invalidName });
      return;
    }
    const targetPath = joinPath(folderPath, name);
    try {
      // Never clobber an existing entry: mkdir(recursive) is a silent no-op on an
      // existing dir, and writeTextFile('') would truncate an existing file —
      // both must surface "already exists" instead.
      if (await exists(targetPath)) {
        useToastStore.getState().addToast({ type: 'error', title: failTitle, message: t.panel.fileTree.alreadyExists });
        return;
      }
      if (kind === 'folder') {
        await mkdir(targetPath, { recursive: true });
      } else {
        await writeTextFile(targetPath, '');
        openPreview(targetPath);
      }
      refresh();
    } catch (err) {
      useToastStore.getState().addToast({
        type: 'error',
        title: failTitle,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleDeleteConfirmed = async (entry: WorkspaceTreeEntry) => {
    setContextMenu(null);
    setConfirmingDelete(false);
    // Defense in depth: the fs:allow-remove capability is broad ($HOME/**, to
    // match write/rename), so the ONLY thing keeping this recursive delete from
    // touching files outside the project is that the tree is rooted at the
    // workspace. Enforce that explicitly — refuse to remove the root itself or
    // anything not strictly under it, so a bad entry.path can never escape.
    const root = rootPath ? normalizeSeparators(rootPath).replace(/\/+$/, '') : '';
    const target = normalizeSeparators(entry.path).replace(/\/+$/, '');
    if (!root || !target.startsWith(root + '/')) {
      useToastStore.getState().addToast({
        type: 'error',
        title: t.panel.fileTree.deleteFailed,
        message: t.panel.fileTree.invalidName,
      });
      return;
    }
    try {
      // Move to the OS trash (Finder / Recycle Bin) instead of permanently
      // deleting — recoverable, and it runs via our own Rust command so it
      // doesn't depend on the fs:remove capability scope. Directories go whole.
      await invoke('move_to_trash', { path: entry.path });
      // Close the preview if it was showing the trashed file OR any file under a
      // trashed folder — otherwise the preview panel keeps rendering a
      // now-missing path.
      const previewed = usePreviewStore.getState().previewFilePath;
      if (previewed === entry.path || (previewed && previewed.startsWith(entry.path + '/'))) {
        usePreviewStore.getState().closePreview();
      }
      refresh();
    } catch (err) {
      useToastStore.getState().addToast({
        type: 'error',
        title: t.panel.fileTree.deleteFailed,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0 gap-2 mt-3">
      <div className="flex items-center justify-between shrink-0">
        <h4 className="text-[11px] font-medium text-[var(--abu-text-muted)] uppercase tracking-wider">
          {t.panel.fileTree.title}
        </h4>
        {rootPath && (
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="p-1 rounded hover:bg-[var(--abu-bg-hover)] text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)]"
              title={t.panel.fileTree.moreActions}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
            {menuOpen && (
              <div className="absolute top-full right-0 mt-1 z-50 w-36 bg-[var(--abu-bg-base)] border border-[var(--abu-border)] rounded-lg shadow-lg py-1">
                <button onClick={handleNewFolder} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)]">
                  <FolderPlus className="h-3.5 w-3.5 shrink-0" /> {t.panel.fileTree.newFolder}
                </button>
                <button onClick={handleAddFile} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)]">
                  <FilePlus className="h-3.5 w-3.5 shrink-0" /> {t.panel.fileTree.addFile}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {creatingFolder && (
        <div className="shrink-0 flex items-center gap-1.5 px-1">
          <FolderPlus className="h-3.5 w-3.5 text-[var(--abu-text-muted)] shrink-0" />
          <InlineNameInput
            placeholder={t.panel.fileTree.newFolderPlaceholder}
            onSubmit={submitNewFolder}
            onCancel={() => setCreatingFolder(false)}
          />
        </div>
      )}

      {!rootPath ? (
        <p className="text-[12px] text-[var(--abu-text-muted)] py-1">{t.panel.fileTree.noWorkspace}</p>
      ) : rootMissing ? (
        <p className="text-[12px] text-[var(--abu-text-muted)] py-1">{t.panel.fileTree.folderDeleted}</p>
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
                onContextMenu={handleRowContextMenu}
                renamingPath={renamingPath}
                onRenameSubmit={handleRenameSubmit}
                onRenameCancel={() => setRenamingPath(null)}
                creatingInFolder={creatingInFolder}
                onCreateSubmit={handleCreateSubmit}
                onCreateCancel={() => setCreatingInFolder(null)}
                t={t}
              />
            ))}
          </div>
        </ScrollArea>
      )}

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 bg-[var(--abu-bg-base)] rounded-lg shadow-lg border border-[var(--abu-border)] py-1 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {confirmingDelete ? (
            <div className="px-3 py-2">
              <p className="text-[12px] text-[var(--abu-text-secondary)] mb-2">{t.panel.fileTree.confirmDelete}</p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleDeleteConfirmed(contextMenu.entry)}
                  className="px-2.5 py-1 rounded text-[12px] font-medium bg-red-500/10 text-red-500 hover:bg-red-500/20"
                >
                  {t.panel.fileTree.moveToTrash}
                </button>
                <button
                  onClick={() => setContextMenu(null)}
                  className="px-2.5 py-1 rounded text-[12px] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)]"
                >
                  {t.common.cancel}
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                onClick={() => handleRevealInFinder(contextMenu.entry)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)]"
              >
                <ExternalLink className="h-3.5 w-3.5 shrink-0" /> {t.panel.fileTree.revealInFinder}
              </button>
              {!contextMenu.entry.isDirectory && (
                <button
                  onClick={() => handleAddToChat(contextMenu.entry)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)]"
                >
                  <Paperclip className="h-3.5 w-3.5 shrink-0" /> {t.panel.fileTree.addToChat}
                </button>
              )}
              <button
                onClick={() => handleCopyPath(contextMenu.entry)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)]"
              >
                <Copy className="h-3.5 w-3.5 shrink-0" /> {t.panel.fileTree.copyPath}
              </button>
              <button
                onClick={() => handleStartRename(contextMenu.entry)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)]"
              >
                <Pencil className="h-3.5 w-3.5 shrink-0" /> {t.panel.fileTree.rename}
              </button>
              {contextMenu.entry.isDirectory && (
                <>
                  <button
                    onClick={() => handleStartCreateInFolder(contextMenu.entry, 'file')}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)]"
                  >
                    <FilePlus className="h-3.5 w-3.5 shrink-0" /> {t.panel.fileTree.newFile}
                  </button>
                  <button
                    onClick={() => handleStartCreateInFolder(contextMenu.entry, 'folder')}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)]"
                  >
                    <FolderPlus className="h-3.5 w-3.5 shrink-0" /> {t.panel.fileTree.newFolder}
                  </button>
                </>
              )}
              <div className="my-1 border-t border-[var(--abu-border)]" />
              <button
                onClick={(e) => { e.stopPropagation(); setConfirmingDelete(true); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-red-500 hover:bg-[var(--abu-bg-hover)]"
              >
                <Trash2 className="h-3.5 w-3.5 shrink-0" /> {t.panel.fileTree.delete}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
