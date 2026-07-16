import { useCallback, useEffect, useRef, useState } from 'react';
import { readDir, watch, exists, type DirEntry, type UnwatchFn } from '@tauri-apps/plugin-fs';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { joinPath } from '@/utils/pathUtils';

/**
 * A single lazily-discovered entry in the workspace file tree.
 * `path` is the full absolute path (parent path joined with `name`).
 */
export interface WorkspaceTreeEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
}

/** Exact directory/file names to always hide — keeps the tree lightweight, not an IDE explorer. */
const IGNORED_EXACT_NAMES = new Set(['node_modules', '.git', '.DS_Store']);

function isIgnoredEntryName(name: string): boolean {
  if (IGNORED_EXACT_NAMES.has(name)) return true;
  // Hidden files/folders (dotfiles) are noise for a lightweight project glance.
  if (name.startsWith('.')) return true;
  return false;
}

/** Folders first, then files; each group sorted locale-aware (case-insensitive, numeric-aware) by name. */
function sortEntries(entries: WorkspaceTreeEntry[]): WorkspaceTreeEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  });
}

function toTreeEntries(parentPath: string, raw: DirEntry[]): WorkspaceTreeEntry[] {
  const mapped = raw
    .filter((e) => !isIgnoredEntryName(e.name))
    .map((e) => ({
      name: e.name,
      path: joinPath(parentPath, e.name),
      isDirectory: e.isDirectory,
      isSymlink: e.isSymlink,
    }));
  return sortEntries(mapped);
}

export interface UseWorkspaceTreeResult {
  /** Current workspace root path (null if no workspace is bound). */
  rootPath: string | null;
  /** Entries directly under `rootPath` — the tree's depth-0 level. Not a recursive read. */
  rootEntries: WorkspaceTreeEntry[];
  /** True while the root listing is being (re)loaded. */
  isRootLoading: boolean;
  /** Error message from the last root listing attempt, if any. */
  rootError: string | null;
  /**
   * True when the bound root folder does not exist on disk (deleted/moved), as opposed
   * to a generic read error.
   */
  rootMissing: boolean;
  /** Lazily-loaded children, keyed by directory path. Absence means "not loaded yet". */
  childrenByPath: Map<string, WorkspaceTreeEntry[]>;
  /** Directories currently expanded in the UI. */
  expandedPaths: Set<string>;
  /** Directories currently fetching their children. */
  loadingPaths: Set<string>;
  /** Per-directory load error, keyed by path. */
  errorsByPath: Map<string, string>;
  /** Toggle expand/collapse for a directory; triggers a lazy `readDir` on first expand. */
  toggleExpand: (dirPath: string) => void;
  /** Re-read the root listing and every currently-expanded directory. */
  refresh: () => void;
}

/**
 * Lazily-loaded workspace directory tree, backed by `@tauri-apps/plugin-fs` `readDir`.
 * Only reads a directory's children when it is expanded — never recurses the whole tree
 * up front. Root path comes from `useWorkspaceStore` and may be null (no workspace bound).
 */
export function useWorkspaceTree(): UseWorkspaceTreeResult {
  const rootPath = useWorkspaceStore((s) => s.currentPath);

  const [rootEntries, setRootEntries] = useState<WorkspaceTreeEntry[]>([]);
  const [isRootLoading, setIsRootLoading] = useState(false);
  const [rootError, setRootError] = useState<string | null>(null);
  const [rootMissing, setRootMissing] = useState(false);

  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [childrenByPath, setChildrenByPath] = useState<Map<string, WorkspaceTreeEntry[]>>(new Map());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [errorsByPath, setErrorsByPath] = useState<Map<string, string>>(new Map());

  // Bumped whenever the workspace root changes, so stale async responses from a
  // previous root (e.g. slow readDir landing after the user switched workspaces)
  // are discarded instead of corrupting the new tree's state.
  const epochRef = useRef(0);

  const loadDir = useCallback(async (dirPath: string, isRoot: boolean) => {
    const epoch = epochRef.current;

    if (isRoot) {
      setIsRootLoading(true);
      setRootError(null);
    } else {
      setLoadingPaths((prev) => new Set(prev).add(dirPath));
      setErrorsByPath((prev) => {
        if (!prev.has(dirPath)) return prev;
        const next = new Map(prev);
        next.delete(dirPath);
        return next;
      });
    }

    try {
      const raw = await readDir(dirPath);
      if (epoch !== epochRef.current) return; // stale — workspace root changed mid-flight
      const entries = toTreeEntries(dirPath, raw);
      if (isRoot) {
        setRootEntries(entries);
        setRootMissing(false);
      } else {
        setChildrenByPath((prev) => new Map(prev).set(dirPath, entries));
      }
    } catch (err) {
      if (epoch !== epochRef.current) return;
      const message = err instanceof Error ? err.message : String(err);
      if (isRoot) {
        setRootEntries([]);
        // Distinguish "folder no longer exists" (deleted/moved) from a genuine read
        // error (permissions, etc.) so the UI can show a clearer message and let the
        // focus-recheck effect below auto-recover once the folder is restored.
        const stillThere = await exists(dirPath).catch(() => false);
        if (epoch !== epochRef.current) return; // stale — workspace root changed mid-flight
        if (!stillThere) {
          setRootMissing(true);
          setRootError(null);
        } else {
          setRootMissing(false);
          setRootError(message);
        }
      } else {
        setErrorsByPath((prev) => new Map(prev).set(dirPath, message));
      }
    } finally {
      if (epoch === epochRef.current) {
        if (isRoot) {
          setIsRootLoading(false);
        } else {
          setLoadingPaths((prev) => {
            if (!prev.has(dirPath)) return prev;
            const next = new Set(prev);
            next.delete(dirPath);
            return next;
          });
        }
      }
    }
  }, []);

  // Reset the whole tree and reload the root listing whenever the workspace changes.
  useEffect(() => {
    epochRef.current += 1;
    setExpandedPaths(new Set());
    setChildrenByPath(new Map());
    setLoadingPaths(new Set());
    setErrorsByPath(new Map());
    setRootEntries([]);
    setRootError(null);
    setRootMissing(false);
    if (rootPath) {
      void loadDir(rootPath, true);
    }
    // loadDir is stable (useCallback with an empty dep array).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath]);

  const toggleExpand = useCallback((dirPath: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
      }
      return next;
    });
  }, []);

  // Whenever a new directory becomes expanded, lazily fetch its children once.
  useEffect(() => {
    expandedPaths.forEach((dirPath) => {
      if (!childrenByPath.has(dirPath) && !loadingPaths.has(dirPath)) {
        void loadDir(dirPath, false);
      }
    });
    // Only re-run when the expanded set itself changes — childrenByPath/loadingPaths
    // are read for their latest values but must not retrigger this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedPaths]);

  // Re-read the root and every currently-expanded directory (P1 auto-refresh hook point).
  const refresh = useCallback(() => {
    if (rootPath) {
      void loadDir(rootPath, true);
    }
    setExpandedPaths((prev) => {
      prev.forEach((dirPath) => void loadDir(dirPath, false));
      return prev;
    });
  }, [rootPath, loadDir]);

  // Keep a ref to the latest refresh so the watch effect (keyed only on
  // rootPath) can invoke it without re-subscribing on every refresh-identity change.
  const refreshRef = useRef(refresh);
  useEffect(() => { refreshRef.current = refresh; }, [refresh]);

  // Keep a ref to the latest rootMissing so the focus listener below (subscribed once)
  // can read the current value without re-subscribing on every change.
  const rootMissingRef = useRef(rootMissing);
  useEffect(() => { rootMissingRef.current = rootMissing; }, [rootMissing]);

  // Auto re-recognition: if the bound folder is currently missing, recheck when the
  // window regains focus (e.g. the user restored the folder in Finder and switched
  // back to Abu). Gated on rootMissingRef so there is zero extra readDir in the
  // normal (healthy) case — this only fires while the tree is in the "missing" state.
  useEffect(() => {
    const onFocus = () => {
      if (rootMissingRef.current) refreshRef.current();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  // Auto-refresh the tree when files are created/renamed/deleted anywhere under
  // the workspace root (e.g. the agent writes output files, or the user edits in
  // the preview). Recursive, debounced watch → refresh(); without this the tree
  // goes stale until a manual collapse/expand (F3). exists() guard mirrors
  // fileWatcher.ts to avoid plugin-fs "resource id is invalid" on missing paths.
  useEffect(() => {
    if (!rootPath) return;
    let unwatch: UnwatchFn | null = null;
    let disposed = false;
    (async () => {
      try {
        if (!(await exists(rootPath))) return;
        const fn = await watch(rootPath, () => refreshRef.current(), {
          recursive: true,
          delayMs: 300,
        });
        if (disposed) { fn(); return; }
        unwatch = fn;
      } catch (err) {
        console.error('[useWorkspaceTree] workspace watch failed:', rootPath, err);
      }
    })();
    return () => {
      disposed = true;
      if (unwatch) unwatch();
    };
  }, [rootPath]);

  return {
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
  };
}
