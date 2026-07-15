/**
 * Feedback draft store — holds the in-progress feedback form (description,
 * attached conversations, screenshots) so it SURVIVES navigating away from the
 * settings view and back. The settings view is fully unmounted when the user
 * switches to chat (App.tsx renders it behind `viewMode === 'settings'`), which
 * would otherwise wipe component-local state — exactly what happens when a user
 * leaves to grab a screenshot and returns.
 *
 * Intentionally EPHEMERAL (no `persist`): it's a Zustand module singleton, so it
 * outlives component unmount within a session but resets on app reload. Image
 * bytes must never be written to disk, and a stale draft shouldn't resurrect a
 * week later — session-scoped is exactly right.
 *
 * Screenshot blob URLs are owned by the DRAFT lifecycle, not the component:
 * created on add, revoked only on explicit removal or `clearDraft()`. Unmount
 * does NOT revoke them (the store keeps the draft + URL alive across navigation).
 */
import { create } from 'zustand';

export interface ScreenshotDraft {
  id: string;
  name: string;
  bytes: Uint8Array;
  mediaType: string;
  /** `URL.createObjectURL` blob URL for the thumbnail — revoked on removal / clearDraft. */
  previewUrl: string;
}

interface FeedbackDraftState {
  description: string;
  selectedConversationIds: string[];
  /** True once the user has manually changed the selection; until then it
      follows the active conversation (see DiagnosticUpload). */
  touchedSelection: boolean;
  screenshots: ScreenshotDraft[];
}

interface FeedbackDraftActions {
  setDescription: (v: string) => void;
  setSelectedConversationIds: (ids: string[], opts?: { touched?: boolean }) => void;
  /** Accepts an array or a functional updater. The updater form is atomic
      against the latest state — required so two concurrent screenshot adds
      (e.g. a drag mid-way through a paste's async compress) can't clobber
      each other by both committing from the same stale snapshot. */
  setScreenshots: (
    shots: ScreenshotDraft[] | ((prev: ScreenshotDraft[]) => ScreenshotDraft[]),
  ) => void;
  /** Reset the whole draft; revokes any live screenshot blob URLs first. */
  clearDraft: () => void;
}

const EMPTY: FeedbackDraftState = {
  description: '',
  selectedConversationIds: [],
  touchedSelection: false,
  screenshots: [],
};

export const useFeedbackDraftStore = create<FeedbackDraftState & FeedbackDraftActions>((set, get) => ({
  ...EMPTY,

  setDescription: (v) => set({ description: v }),

  setSelectedConversationIds: (ids, opts) =>
    set((s) => ({
      selectedConversationIds: ids,
      touchedSelection: opts?.touched ?? s.touchedSelection,
    })),

  setScreenshots: (shots) =>
    set((s) => ({ screenshots: typeof shots === 'function' ? shots(s.screenshots) : shots })),

  clearDraft: () => {
    for (const s of get().screenshots) URL.revokeObjectURL(s.previewUrl);
    set({ ...EMPTY, selectedConversationIds: [], screenshots: [] });
  },
}));
