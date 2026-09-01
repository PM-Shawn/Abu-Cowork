import { create } from 'zustand';
import { useSettingsStore } from './settingsStore';
import { useBatchProgressStore } from './batchProgressStore';
import { closeBrowserViews } from '@/core/browser/browserViewLifecycle';
import { makeBatchKey, type BatchIdentity } from '@/types';

/**
 * Opening workspace content is an explicit "show me this" intent, so it must
 * also un-collapse the right panel. RightPanel's own auto-expand effect only
 * fires when `hasWideContent` flips false→true — with the panel collapsed but
 * tabs still open, re-clicking a file card changed no state at all and the
 * panel silently stayed hidden.
 */
function expandRightPanel(): void {
  useSettingsStore.getState().setRightPanelCollapsed(false);
}

/**
 * A single tab in the right-panel workspace. `preview` is today's single
 * file preview generalized to N; `browser`/`terminal` are forward-compat
 * placeholders (bodies land in later passes — see
 * `docs/2026-07-17-workspace-tabs-design.md`).
 */
export type WorkspaceTab =
  | { id: string; kind: 'summary' }
  | { id: string; kind: 'preview'; filePath: string }
  | { id: string; kind: 'browser'; url: string }
  | { id: string; kind: 'terminal' }
  | { id: string; kind: 'subagent'; identity: BatchIdentity; taskIndex: number; title: string };

export function subagentTabId(identity: BatchIdentity, taskIndex: number): string {
  return `subagent:${makeBatchKey(identity)}:${taskIndex}`;
}

function safeDomId(id: string): string {
  return encodeURIComponent(id).replace(/%/g, '_');
}

export function workspaceTabButtonId(id: string): string {
  return `workspace-tab-${safeDomId(id)}`;
}

export function workspaceTabPanelId(id: string): string {
  return `workspace-tabpanel-${safeDomId(id)}`;
}

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

/** Active tab's filePath if it's a preview tab, else null. */
function computePreviewFilePath(tabs: WorkspaceTab[], activeTabId: string | null): string | null {
  const active = tabs.find((t) => t.id === activeTabId);
  return active && active.kind === 'preview' ? active.filePath : null;
}

/**
 * Ids of the browser tabs that exist in `oldTabs` but not in `nextTabs` — the
 * tabs whose native views this transition must destroy.
 */
function removedBrowserTabIds(oldTabs: WorkspaceTab[], nextTabs: WorkspaceTab[]): string[] {
  const surviving = new Set(nextTabs.map((tab) => tab.id));
  return oldTabs
    .filter((tab) => tab.kind === 'browser' && !surviving.has(tab.id))
    .map((tab) => tab.id);
}

function activeSubagentIdentity(tabs: WorkspaceTab[], activeTabId: string | null): BatchIdentity | undefined {
  const active = tabs.find((t) => t.id === activeTabId);
  return active?.kind === 'subagent' ? active.identity : undefined;
}

function reconcileSubagentLeases(
  oldTabs: WorkspaceTab[],
  oldActiveTabId: string | null,
  nextTabs: WorkspaceTab[],
  nextActiveTabId: string | null,
): void {
  const oldActive = oldTabs.find((tab) => tab.id === oldActiveTabId && tab.kind === 'subagent');
  const nextActive = nextTabs.find((tab) => tab.id === nextActiveTabId && tab.kind === 'subagent');
  if (oldActive?.id === nextActive?.id) return;
  const batchStore = useBatchProgressStore.getState();
  if (oldActive?.kind === 'subagent') batchStore.releaseViewLease(oldActive.identity);
  if (nextActive?.kind === 'subagent') batchStore.acquireViewLease(nextActive.identity);
}

interface PreviewState {
  // All open workspace tabs (preview/browser/terminal), in display order.
  tabs: WorkspaceTab[];
  // Currently active tab id, or null when there are no tabs.
  activeTabId: string | null;
  focusTabId: string | null;
  // True while a workspace popover (tab-strip `+` / context menu) is open. The
  // native browser webview paints OVER React, so it must hide while a menu is
  // up or the menu is occluded. Ephemeral UI signal.
  menuOpen: boolean;
  // True while an app-global modal (e.g. the close-window dialog) is open.
  // Same z-order problem as menuOpen: the native browser webview would paint
  // over the modal, leaving the user unable to see or click it. Ephemeral.
  appModalOpen: boolean;
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

  // Open (or activate an existing) the singleton "task summary" tab — the
  // default right-panel tab (progress / workspace files / context). Created at
  // the FRONT so it stays leftmost.
  openSummary: () => void;
  // Open (or activate an existing) preview tab for `filePath`. Call sites
  // (~11 across the app) are unchanged from the pre-tabs single-preview API.
  openPreview: (filePath: string) => void;
  // Open (or activate an existing) browser tab for `url` (default ''). Main
  // may supply an id when adopting an agent-created Electron browser view.
  openBrowser: (url?: string, requestedId?: string) => string;
  // Open a new terminal tab (terminals are never deduped — each is its own session).
  openTerminal: () => void;
  openSubagent: (identity: BatchIdentity, taskIndex: number, title: string) => string;
  // Make an existing tab the active one. No-op if the id doesn't exist.
  activateTab: (id: string) => void;
  consumeFocusTabRequest: (id: string) => void;
  // Close a tab, activating a neighbor (prefer the next tab, else the
  // previous one) if the closed tab was active. Empty afterwards ⇒
  // activeTabId becomes null.
  closeTab: (id: string, options?: { focusAfterClose?: boolean }) => void;
  // Close every tab except `id`, which becomes (or stays) active.
  closeOtherTabs: (id: string) => void;
  // Close every tab.
  closeAllTabs: () => void;
  // Reset the panel for a conversation switch: closes every conversation-scoped
  // tab (summary / preview / terminal / subagent) but KEEPS browser tabs, whose
  // native views belong to a running agent rather than to the panel.
  closeTabsForConversationSwitch: () => void;
  // Close subagent tabs owned by one conversation. Other workspace tabs stay
  // open; used by chatStore's synchronous delete cascade.
  closeSubagentTabsForConversation: (conversationId: string) => void;
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
  // Mark a workspace popover as open/closed (so the native browser webview can
  // hide while it's up).
  setMenuOpen: (open: boolean) => void;
  setAppModalOpen: (open: boolean) => void;
}

export const usePreviewStore = create<PreviewState>((set, get) => {
  const commitTabs = (
    nextTabs: WorkspaceTab[],
    nextActiveId: string | null,
    options: { focusTabId?: string | null } = {},
  ): void => {
    const prev = get();
    reconcileSubagentLeases(prev.tabs, prev.activeTabId, nextTabs, nextActiveId);
    // Dropping a browser tab record is the ONLY thing that destroys its native
    // view — see closeBrowserViews. Doing it here (rather than per action)
    // makes it an invariant of the store: no removal path can leak a view, and
    // no UI unmount can kill one.
    closeBrowserViews(removedBrowserTabIds(prev.tabs, nextTabs));
    const previewFilePath = computePreviewFilePath(nextTabs, nextActiveId);
    set({
      tabs: nextTabs,
      activeTabId: nextActiveId,
      previewFilePath,
      focusTabId: options.focusTabId ?? null,
      ...(nextTabs.length === 0 ? { chatWidth: null } : {}),
    });
    useBatchProgressStore.getState().setActiveVisibleBatch(activeSubagentIdentity(nextTabs, nextActiveId));
  };

  return ({
  tabs: [],
  activeTabId: null,
  focusTabId: null,
  menuOpen: false,
  appModalOpen: false,
  chatWidth: null,
  fileTreeMode: false,
  previewFilePath: null,
  reloadNonce: 0,

  openSummary: () => {
    const { tabs } = get();
    const existing = tabs.find((t) => t.kind === 'summary');
    if (existing) {
      commitTabs(tabs, existing.id);
      return;
    }
    const id = genId();
    // Summary is the default tab — put it first so it stays leftmost.
    const nextTabs: WorkspaceTab[] = [{ id, kind: 'summary' }, ...tabs];
    commitTabs(nextTabs, id);
  },

  openPreview: (filePath) => {
    const { tabs } = get();
    const existing = tabs.find((t) => t.kind === 'preview' && t.filePath === filePath);
    if (existing) {
      commitTabs(tabs, existing.id);
      expandRightPanel();
      return;
    }
    const id = genId();
    const nextTabs: WorkspaceTab[] = [...tabs, { id, kind: 'preview', filePath }];
    commitTabs(nextTabs, id);
    expandRightPanel();
  },

  openBrowser: (url = '', requestedId) => {
    const { tabs, activeTabId } = get();
    if (requestedId) {
      const requested = tabs.find((t) => t.id === requestedId);
      if (requested) {
        // Re-entry for an already-adopted id (main's adoption poll re-finding
        // the same view) is a deliberate re-open, not a new-tab event — keep
        // today's re-activate behavior.
        commitTabs(tabs, requested.id);
        return requested.id;
      }
      const nextTabs: WorkspaceTab[] = [...tabs, {
        id: requestedId,
        kind: 'browser',
        url,
      }];
      // Adopting a brand-new agent-created tab must not steal focus from a
      // user who is actively watching a browser tab — add it in the
      // background. If the user isn't on a browser tab (or has no tabs at
      // all), activating it preserves today's single-task first-tab UX.
      const currentActiveIsBrowser = tabs.find((t) => t.id === activeTabId)?.kind === 'browser';
      commitTabs(nextTabs, currentActiveIsBrowser ? activeTabId : requestedId);
      return requestedId;
    }
    const existing = tabs.find((t) => t.kind === 'browser' && t.url === url);
    if (existing) {
      commitTabs(tabs, existing.id);
      expandRightPanel();
      return existing.id;
    }
    const id = genId();
    const nextTabs: WorkspaceTab[] = [...tabs, { id, kind: 'browser', url }];
    commitTabs(nextTabs, id);
    // User-invoked only: the `requestedId` branch above (agent browser-view
    // adoption) intentionally keeps the current collapse state.
    expandRightPanel();
    return id;
  },

  openTerminal: () => {
    const { tabs } = get();
    const id = genId();
    const nextTabs: WorkspaceTab[] = [...tabs, { id, kind: 'terminal' }];
    commitTabs(nextTabs, id);
    expandRightPanel();
  },

  openSubagent: (identity, taskIndex, title) => {
    const { tabs } = get();
    const id = subagentTabId(identity, taskIndex);
    const existing = tabs.find((tab) => tab.id === id);
    if (existing) {
      commitTabs(tabs, id, { focusTabId: id });
      expandRightPanel();
      return id;
    }
    const nextTabs: WorkspaceTab[] = [...tabs, { id, kind: 'subagent', identity, taskIndex, title }];
    commitTabs(nextTabs, id, { focusTabId: id });
    expandRightPanel();
    return id;
  },

  activateTab: (id) => {
    const { tabs } = get();
    if (!tabs.some((t) => t.id === id)) return;
    commitTabs(tabs, id);
  },

  consumeFocusTabRequest: (id) => {
    if (get().focusTabId === id) set({ focusTabId: null });
  },

  closeTab: (id, options) => {
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
    const focusTabId = options?.focusAfterClose && nextActiveId && nextTabs.some((tab) => tab.id === nextActiveId)
      ? nextActiveId
      : null;
    commitTabs(nextTabs, nextActiveId, { focusTabId });
  },

  closeOtherTabs: (id) => {
    const { tabs } = get();
    if (!tabs.some((t) => t.id === id)) return;
    const nextTabs = tabs.filter((t) => t.id === id);
    commitTabs(nextTabs, id);
  },

  closeAllTabs: () => {
    commitTabs([], null);
  },

  closeTabsForConversationSwitch: () => {
    const { tabs, activeTabId } = get();
    // Everything except a browser tab is scoped to the conversation that
    // opened it. A browser tab is a live native view an agent may still be
    // driving — closing it here used to kill the page mid-task (and, on the
    // agent's next action, hand back a brand-new tab id).
    const nextTabs = tabs.filter((tab) => tab.kind === 'browser');
    if (nextTabs.length === tabs.length) return;
    const nextActiveId = activeTabId && nextTabs.some((tab) => tab.id === activeTabId)
      ? activeTabId
      : nextTabs[0]?.id ?? null;
    commitTabs(nextTabs, nextActiveId);
  },

  closeSubagentTabsForConversation: (conversationId) => {
    const { tabs, activeTabId } = get();
    const matches = (tab: WorkspaceTab): boolean =>
      tab.kind === 'subagent' && tab.identity.conversationId === conversationId;
    if (!tabs.some(matches)) return;
    const nextTabs = tabs.filter((tab) => !matches(tab));
    let nextActiveId = activeTabId;
    if (activeTabId && !nextTabs.some((tab) => tab.id === activeTabId)) {
      const oldIdx = tabs.findIndex((tab) => tab.id === activeTabId);
      const survives = (tab: WorkspaceTab): boolean => nextTabs.some((next) => next.id === tab.id);
      const after = tabs.slice(oldIdx + 1).find(survives);
      const before = tabs.slice(0, oldIdx).reverse().find(survives);
      nextActiveId = (after ?? before)?.id ?? null;
    }
    commitTabs(nextTabs, nextActiveId);
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
    commitTabs(nextTabs, nextActiveId);
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
    commitTabs(nextTabs, activeTabId);
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

  setMenuOpen: (open) => {
    set({ menuOpen: open });
  },

  setAppModalOpen: (open) => {
    set({ appModalOpen: open });
  },
  });
});

/** True while the workspace has at least one open tab. */
export function useHasTabs(): boolean {
  return usePreviewStore((s) => s.tabs.length > 0);
}
