import { create } from 'zustand';

interface PreviewState {
  // Currently previewed file path
  previewFilePath: string | null;
  // Resizable chat-column width (px) while a preview is open; null = use default.
  // The preview column flex-fills whatever the chat leaves.
  chatWidth: number | null;
  // Bumped whenever the currently-previewed file changes on disk (fs watch)
  // or a caller explicitly requests a re-render. Purely ephemeral signal —
  // no meaning on its own beyond "different from last render". Not persisted
  // (this store has no `persist` middleware; it's in-memory UI state).
  reloadNonce: number;
  // True while the left sidebar is showing the active conversation's project
  // file tree (TRAE-style file mode). Lives here (not local Sidebar state) so
  // RightPanel can read it and skip its "collapse the sidebar when a preview
  // opens" behavior — otherwise clicking a file in the tree would collapse the
  // very sidebar that hosts the tree. Ephemeral (no persist).
  fileTreeMode: boolean;
  // Which right-panel tab is active. 'summary' = the task-summary sections
  // (progress/workspace/context); 'preview' = the file preview. previewFilePath
  // only decides whether the preview TAB exists — this decides what's shown.
  // Ephemeral UI state (no persist); resets to 'summary' on close.
  activeRightTab: 'summary' | 'preview';
  // Whether the preview is expanded to the app-fullscreen overlay. Lifted here
  // (from PreviewPanel local state) so the tab bar's expand button can toggle it.
  previewFullscreen: boolean;
  // Open file preview in right panel
  openPreview: (filePath: string) => void;
  // Close preview
  closePreview: () => void;
  // Set the chat-column width (during drag)
  setChatWidth: (width: number | null) => void;
  // Force the preview to re-read/re-render the current file (fs-watch driven
  // auto-refresh, or manual "reload" affordance).
  refreshPreview: () => void;
  // Toggle the sidebar file-tree mode.
  setFileTreeMode: (on: boolean) => void;
  // Select the active right-panel tab.
  setActiveRightTab: (tab: 'summary' | 'preview') => void;
  // Toggle/set the preview app-fullscreen overlay.
  setPreviewFullscreen: (on: boolean) => void;
}

export const usePreviewStore = create<PreviewState>((set) => ({
  previewFilePath: null,
  chatWidth: null,
  reloadNonce: 0,
  fileTreeMode: false,
  activeRightTab: 'summary',
  previewFullscreen: false,

  openPreview: (filePath) => {
    // Switching to a different file already forces PreviewPanel's loadFile
    // effect to re-run (previewFilePath is a dep), so reloadNonce is left
    // untouched here. Re-opening the *same* path (no-op for React state)
    // relies on the caller invoking refreshPreview() explicitly.
    // Opening a file activates the preview tab and drops any lingering fullscreen
    // from a previously-previewed file (the new file should open in the normal column).
    set({ previewFilePath: filePath, activeRightTab: 'preview', previewFullscreen: false });
  },

  closePreview: () => {
    // Closing the preview tab falls back to the always-present summary tab.
    set({ previewFilePath: null, chatWidth: null, activeRightTab: 'summary', previewFullscreen: false });
  },

  setActiveRightTab: (tab) => {
    set({ activeRightTab: tab });
  },

  setPreviewFullscreen: (on) => {
    set({ previewFullscreen: on });
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
