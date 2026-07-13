import { useCallback, useEffect, useState } from 'react';

/**
 * Render windowing for long conversations (long-conversation Part B / B3).
 *
 * `conv.messages` stays fully in memory — compaction, editing, and export all
 * keep operating on the full array. This hook only tracks how many of the
 * (already-grouped, cheap-to-compute) message groups should actually be
 * mounted in the DOM, so an ultra-long chat doesn't force React to render
 * thousands of `MessageGroup`s at once.
 *
 * Renders the most recent `renderLimit` groups (tail slice — the caller is
 * responsible for slicing `messageGroups.slice(-renderLimit)`). Scrolling up
 * to the top sentinel calls `loadEarlier()`, which grows the window by
 * another `RENDER_WINDOW` groups. Switching conversations resets the window
 * back to `RENDER_WINDOW` so re-opening a huge conversation doesn't re-mount
 * everything either.
 */
export const RENDER_WINDOW = 40;

export interface UseRenderWindowResult {
  /** How many trailing message groups should be mounted. */
  renderLimit: number;
  /** Grow the render window by another `RENDER_WINDOW` groups. */
  loadEarlier: () => void;
  /** True when there are more groups than currently rendered — i.e. the
   *  top sentinel (and its IntersectionObserver) should be mounted. */
  showSentinel: boolean;
}

export function useRenderWindow(
  totalGroups: number,
  activeConvId: string | null | undefined,
): UseRenderWindowResult {
  const [renderLimit, setRenderLimit] = useState(RENDER_WINDOW);

  // Reset the window whenever the active conversation changes, so opening a
  // different (possibly huge) conversation always starts from the tail.
  useEffect(() => {
    setRenderLimit(RENDER_WINDOW);
  }, [activeConvId]);

  const loadEarlier = useCallback(() => {
    setRenderLimit((n) => n + RENDER_WINDOW);
  }, []);

  const showSentinel = totalGroups > renderLimit;

  return { renderLimit, loadEarlier, showSentinel };
}
