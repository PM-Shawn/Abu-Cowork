/**
 * Global file-refresh signal.
 *
 * When a snapshot is restored (or saved-as) anywhere in the UI, we need ALL
 * components currently displaying that file (or any file in the same conversation)
 * to re-run resolveFileSource so the button state flips back from "Restore" to
 * "Open in Finder".
 *
 * This is a tiny zustand store with a single monotonic tick. Subscribers depend
 * on the tick in their resolve effect — incrementing the tick re-runs the effect
 * across all live FileAttachment / FilesSection cards.
 *
 * Coarse but effective: a single restore briefly re-resolves every visible file
 * card. The cost is one fs.exists() per card, which is negligible.
 */

import { create } from 'zustand';

interface FileRefreshStore {
  tick: number;
  bump: () => void;
}

export const useFileRefreshStore = create<FileRefreshStore>((set) => ({
  tick: 0,
  bump: () => set((state) => ({ tick: state.tick + 1 })),
}));

/** Imperative bump for non-React callers (e.g. utility flows) */
export function bumpFileRefresh(): void {
  useFileRefreshStore.getState().bump();
}
