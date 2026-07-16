import { create } from 'zustand';

/**
 * A single tab in the right-panel workspace. `preview` is today's single
 * file preview generalized to N; `browser`/`terminal` are forward-compat
 * placeholders (bodies land in later passes — see
 * `docs/2026-07-17-workspace-tabs-design.md`).
 */
export type WorkspaceTab =
  | { id: string; kind: 'preview'; filePath: string }
  | { id: string; kind: 'browser'; url: string }
  | { id: string; kind: 'terminal' };

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

/** Active tab's filePath if it's a preview tab, else null. */
function computePreviewFilePath(tabs: WorkspaceTab[], activeTabId: string | null): string | null {
  const active = tabs.find((t) => t.id === activeTabId);
  return active && active.kind === 'preview' ? active.filePath : null;
}

interface PreviewState {
  // All open workspace tabs (preview/browser/terminal), in display order.
  tabs: WorkspaceTab[];
  // Currently active tab id, or null when there are no tabs.
  activeTabId: string | null;
  // Resizable chat-column width (px) while the workspace is open; null = use default.
  // The workspace column flex-fills whatever the chat leaves.
  chatWidth: number | null;
  // True while the left sidebar is showing the active conversation's project
  // file tree (TRAE-style file mode). Lives here (not local Sidebar state) so
  // RightPanel can read it and skip its "collapse the sidebar when a preview
  // opens" behavior — otherwise clicking a file in the tree would collapse the
  // very sidebar that hosts the tree. Ephemeral (no persist).
  fileTreeMode: boolean;
  // Back-compat derived read for the many call sites that only care about
  // "the currently previewed file": active tab's filePath if it's a preview
  // tab, else null. Kept as a plain field (not a getter) so it stays
  // reactive through Zustand's subscription model — recomputed inside every
  // action that touches tabs/activeTabId.
  previewFilePath: string | null;
  // Legacy global refresh signal. No longer read by PreviewPanel instances
  // (each manages its own local reload nonce — see usePreviewFileWatch), kept
  // only as the back-compat fallback target for usePreviewFileWatch() callers
  // that don't pass an onChange callback.
  reloadNonce: number;

  // Open (or activate an existing) preview tab for `filePath`. Call sites
  // (~11 across the app) are unchanged from the pre-tabs single-preview API.
  openPreview: (filePath: string) => void;
  // Open (or activate an existing) browser tab for `url` (default '').
  openBrowser: (url?: string) => void;
  // Open a new terminal tab (terminals are never deduped — each is its own session).
  openTerminal: () => void;
  // Make an existing tab the active one. No-op if the id doesn't exist.
  activateTab: (id: string) => void;
  // Close a tab, activating a neighbor (prefer the next tab, else the
  // previous one) if the closed tab was active. Empty afterwards ⇒
  // activeTabId becomes null.
  closeTab: (id: string) => void;
  // Close every tab except `id`, which becomes (or stays) active.
  closeOtherTabs: (id: string) => void;
  // Close every tab.
  closeAllTabs: () => void;
  // Drag-reorder: move the tab with id `fromId` to `toId`'s position.
  reorderTabs: (fromId: string, toId: string) => void;
  // Commit a new URL for a browser tab (address-bar navigation).
  updateBrowserUrl: (id: string, url: string) => void;
  // Close every preview tab whose file is `path` or lives under it (folder
  // delete) — iterates ALL preview tabs, not just the active one. No-op for
  // browser/terminal tabs. Used when a previewed file/folder is trashed in the
  // file tree (must NOT close unrelated tabs or kill terminals).
  closePreviewTabsForPath: (path: string) => void;
  // Re-point every preview tab whose file is `oldPath` (or lives under it, for
  // a folder rename) to the corresponding path under `newPath`, in place (no
  // new tab). Used when a previewed file/folder is renamed in the file tree.
  retargetPreviewPath: (oldPath: string, newPath: string) => void;
  // Back-compat alias for closeAllTabs() — the conversation-change effect
  // used this name before tabs existed.
  closePreview: () => void;
  // Set the chat-column width (during drag)
  setChatWidth: (width: number | null) => void;
  // Force a refresh of whatever is displayed. Legacy/back-compat only — see
  // `reloadNonce` above.
  refreshPreview: () => void;
  // Toggle the sidebar file-tree mode.
  setFileTreeMode: (on: boolean) => void;
}

export const usePreviewStore = create<PreviewState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  chatWidth: null,
  fileTreeMode: false,
  previewFilePath: null,
  reloadNonce: 0,

  openPreview: (filePath) => {
    const { tabs } = get();
    const existing = tabs.find((t) => t.kind === 'preview' && t.filePath === filePath);
    if (existing) {
      set({ activeTabId: existing.id, previewFilePath: filePath });
      return;
    }
    const id = genId();
    const nextTabs: WorkspaceTab[] = [...tabs, { id, kind: 'preview', filePath }];
    set({ tabs: nextTabs, activeTabId: id, previewFilePath: filePath });
  },

  openBrowser: (url = '') => {
    const { tabs } = get();
    const existing = tabs.find((t) => t.kind === 'browser' && t.url === url);
    if (existing) {
      set({ activeTabId: existing.id, previewFilePath: null });
      return;
    }
    const id = genId();
    const nextTabs: WorkspaceTab[] = [...tabs, { id, kind: 'browser', url }];
    set({ tabs: nextTabs, activeTabId: id, previewFilePath: null });
  },

  openTerminal: () => {
    const { tabs } = get();
    const id = genId();
    const nextTabs: WorkspaceTab[] = [...tabs, { id, kind: 'terminal' }];
    set({ tabs: nextTabs, activeTabId: id, previewFilePath: null });
  },

  activateTab: (id) => {
    const { tabs } = get();
    if (!tabs.some((t) => t.id === id)) return;
    set({ activeTabId: id, previewFilePath: computePreviewFilePath(tabs, id) });
  },

  closeTab: (id) => {
    const { tabs, activeTabId } = get();
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const nextTabs = tabs.filter((t) => t.id !== id);
    let nextActiveId = activeTabId;
    if (activeTabId === id) {
      // Prefer the tab that was next (now shifted into `idx`'s slot), else
      // the one before it, else there's nothing left.
      const neighbor = tabs[idx + 1] ?? tabs[idx - 1] ?? null;
      nextActiveId = neighbor ? neighbor.id : null;
    }
    set({
      tabs: nextTabs,
      activeTabId: nextActiveId,
      previewFilePath: computePreviewFilePath(nextTabs, nextActiveId),
      ...(nextTabs.length === 0 ? { chatWidth: null } : {}),
    });
  },

  closeOtherTabs: (id) => {
    const { tabs } = get();
    if (!tabs.some((t) => t.id === id)) return;
    const nextTabs = tabs.filter((t) => t.id === id);
    set({ tabs: nextTabs, activeTabId: id, previewFilePath: computePreviewFilePath(nextTabs, id) });
  },

  closeAllTabs: () => {
    set({ tabs: [], activeTabId: null, previewFilePath: null, chatWidth: null });
  },

  reorderTabs: (fromId, toId) => {
    const { tabs } = get();
    const fromIdx = tabs.findIndex((t) => t.id === fromId);
    const toIdx = tabs.findIndex((t) => t.id === toId);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
    const nextTabs = [...tabs];
    const [moved] = nextTabs.splice(fromIdx, 1);
    nextTabs.splice(toIdx, 0, moved);
    set({ tabs: nextTabs });
  },

  updateBrowserUrl: (id, url) => {
    const { tabs } = get();
    const nextTabs = tabs.map((t) => (t.id === id && t.kind === 'browser' ? { ...t, url } : t));
    set({ tabs: nextTabs });
  },

  closePreviewTabsForPath: (path) => {
    const { tabs, activeTabId } = get();
    const matches = (t: WorkspaceTab): boolean =>
      t.kind === 'preview' && (t.filePath === path || t.filePath.startsWith(path + '/'));
    if (!tabs.some(matches)) return;
    const nextTabs = tabs.filter((t) => !matches(t));
    let nextActiveId = activeTabId;
    if (activeTabId && !nextTabs.some((t) => t.id === activeTabId)) {
      // The active tab was among those closed — activate the nearest survivor
      // (search forward from its old slot, then backward).
      const oldIdx = tabs.findIndex((t) => t.id === activeTabId);
      const survives = (t: WorkspaceTab) => nextTabs.some((n) => n.id === t.id);
      const after = tabs.slice(oldIdx + 1).find(survives);
      const before = tabs.slice(0, oldIdx).reverse().find(survives);
      nextActiveId = (after ?? before)?.id ?? null;
    }
    set({
      tabs: nextTabs,
      activeTabId: nextActiveId,
      previewFilePath: computePreviewFilePath(nextTabs, nextActiveId),
      ...(nextTabs.length === 0 ? { chatWidth: null } : {}),
    });
  },

  retargetPreviewPath: (oldPath, newPath) => {
    const { tabs, activeTabId } = get();
    let changed = false;
    const nextTabs = tabs.map((t) => {
      if (t.kind !== 'preview') return t;
      if (t.filePath === oldPath) {
        changed = true;
        return { ...t, filePath: newPath };
      }
      if (t.filePath.startsWith(oldPath + '/')) {
        changed = true;
        return { ...t, filePath: newPath + t.filePath.slice(oldPath.length) };
      }
      return t;
    });
    if (!changed) return;
    set({ tabs: nextTabs, previewFilePath: computePreviewFilePath(nextTabs, activeTabId) });
  },

  closePreview: () => {
    get().closeAllTabs();
  },

  setChatWidth: (width) => {
    set({ chatWidth: width });
  },

  refreshPreview: () => {
    set((s) => ({ reloadNonce: s.reloadNonce + 1 }));
  },

  setFileTreeMode: (on) => {
    set({ fileTreeMode: on });
  },
}));

/** True while the workspace has at least one open tab. */
export function useHasTabs(): boolean {
  return usePreviewStore((s) => s.tabs.length > 0);
}
