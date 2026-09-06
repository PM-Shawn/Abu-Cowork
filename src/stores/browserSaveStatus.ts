/**
 * Whether the last edit to a browser authorization setting actually reached
 * storage (S18).
 *
 * ## Why this exists at all
 *
 * Until now a settings change was assumed to have been saved because React
 * re-rendered. It usually had. But `localStorage` can refuse a write — quota
 * exhausted by a long conversation history, a browser configured to block site
 * data, a private window — and when it did, the pane went on showing the new
 * value while the gate went on enforcing the old one. That is the worst
 * possible shape for a permission control: the user believes they tightened
 * something, and nothing tells them they did not.
 *
 * So every write to one of the three browser fields is confirmed by reading it
 * back, and this store carries the answer to the row that produced it.
 *
 * ## Deliberately ephemeral (no `persist`)
 *
 * The repo's rule is that a new store gets `persist` unless it is purely
 * ephemeral by design. This one is: it holds the outcome of a write that just
 * happened. Persisting it would restore, on the next launch, a 「未能保存」 about
 * an edit from last week — a warning with nothing behind it, which is exactly
 * the class of lie this store was added to stop.
 *
 * ## What each state means
 *
 * - `saving` — the write is in flight and no confirmation has come back. With
 *   today's synchronous `localStorage` this is over within the same tick and
 *   the user never sees it; it exists because the state machine has to be
 *   correct, not because the spinner is interesting.
 * - `saved` — read back from storage and matched. The row shows it briefly and
 *   then stops mentioning it.
 * - `failed` — the write threw, or the read-back did not match. The field has
 *   been rolled back to its last confirmed value and the row offers a retry.
 *   Only the field that failed is rolled back: another pane's successful save
 *   of a different field is not undone by this one's failure.
 */
import { create } from 'zustand';
import type { BrowserConfigField } from './browserConfigPersistence';

export type BrowserSaveState = 'idle' | 'saving' | 'saved' | 'failed';

interface BrowserSaveStatusState {
  status: Partial<Record<BrowserConfigField, BrowserSaveState>>;
}

interface BrowserSaveStatusActions {
  /** A write for this field is starting. */
  beginBrowserSave: (field: BrowserConfigField) => void;
  /** The write came back. */
  settleBrowserSave: (field: BrowserConfigField, outcome: 'saved' | 'failed') => void;
  /** Stop mentioning a success once the user has had a chance to see it. */
  clearBrowserSaveStatus: (field: BrowserConfigField) => void;
  /** Test-only — this is module-level state shared across a test file. */
  __resetBrowserSaveStatus: () => void;
}

export type BrowserSaveStatusStore = BrowserSaveStatusState & BrowserSaveStatusActions;

export const useBrowserSaveStatusStore = create<BrowserSaveStatusStore>()((set) => ({
  status: {},
  beginBrowserSave: (field) => set((s) => ({ status: { ...s.status, [field]: 'saving' } })),
  settleBrowserSave: (field, outcome) =>
    set((s) => ({ status: { ...s.status, [field]: outcome } })),
  clearBrowserSaveStatus: (field) => set((s) => {
    const next = { ...s.status };
    delete next[field];
    return { status: next };
  }),
  __resetBrowserSaveStatus: () => set({ status: {} }),
}));

/** Imperative access for the store/storage layer, which is not a component. */
export const browserSaveStatus = {
  begin: (field: BrowserConfigField) =>
    useBrowserSaveStatusStore.getState().beginBrowserSave(field),
  settle: (field: BrowserConfigField, outcome: 'saved' | 'failed') =>
    useBrowserSaveStatusStore.getState().settleBrowserSave(field, outcome),
};
