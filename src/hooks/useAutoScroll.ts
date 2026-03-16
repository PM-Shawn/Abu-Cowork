import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Auto-scroll hook for streaming chat.
 *
 * Two modes of operation:
 *
 * **Normal mode** (following=false):
 *   MutationObserver + ResizeObserver detect DOM changes and scroll to bottom
 *   once per animation frame. `isProgrammaticScroll` flag + settling window
 *   prevent scroll events from falsely disabling auto-scroll.
 *
 * **Following mode** (following=true):
 *   A dedicated RAF loop scrolls every frame for jitter-free streaming.
 *   Observer-based scroll is paused. User scroll-up is detected inside the
 *   RAF tick by comparing current scrollTop with the last value we set,
 *   guarded against content-shrink false positives.
 */
export function useAutoScroll(options?: { following?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const isAtBottomRef = useRef(true);
  const rafId = useRef(0);
  // Flag to skip scroll-handler check after programmatic scrolls.
  // Prevents a race where new content arrives between scrollTop assignment
  // and the async scroll event, causing checkIfAtBottom() to return false.
  const isProgrammaticScroll = useRef(false);
  // Settling window: after scrollToBottom / resetToBottom, ignore scroll
  // events for a short period while child components finish rendering and
  // content height stabilizes (prevents bounce on conversation switch).
  const settlingUntilRef = useRef(0);
  const following = options?.following ?? false;
  const followingRef = useRef(false);
  useEffect(() => { followingRef.current = following; }, [following]);

  const checkIfAtBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return true;
    const { scrollTop, scrollHeight, clientHeight } = container;
    return scrollTop + clientHeight >= scrollHeight - 100;
  }, []);

  // Scroll to bottom and open a 300ms settling window.
  // Used by: conversation switch (useLayoutEffect), scroll-to-bottom button.
  const scrollToBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    isProgrammaticScroll.current = true;
    container.scrollTop = container.scrollHeight;
    isAtBottomRef.current = true;
    setIsAtBottom(true);
    settlingUntilRef.current = Date.now() + 300;
  }, []);

  // Re-enable auto-scroll and scroll to bottom immediately.
  // Used when the user sends a message.
  const resetToBottom = useCallback(() => {
    const container = containerRef.current;
    if (container) {
      isProgrammaticScroll.current = true;
      container.scrollTop = container.scrollHeight;
    }
    isAtBottomRef.current = true;
    setIsAtBottom(true);
    settlingUntilRef.current = Date.now() + 300;
  }, []);

  // Track scroll position — works for both user and programmatic scrolls.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      // During settling window (after conversation switch / send message),
      // ignore scroll events while content height stabilizes.
      if (Date.now() < settlingUntilRef.current) return;

      // During following mode, the RAF tick is the single source of truth
      // for both scrolling and user-scroll-up detection. Skip all scroll
      // event processing to avoid racing with the RAF loop.
      if (followingRef.current) return;

      // Normal mode: skip check for programmatic scrolls — the race between
      // scrollTop assignment and this async event can cause false negatives.
      if (isProgrammaticScroll.current) {
        isProgrammaticScroll.current = false;
        return;
      }
      const atBottom = checkIfAtBottom();
      // Only update state when the value actually changes to avoid re-renders
      if (atBottom !== isAtBottomRef.current) {
        isAtBottomRef.current = atBottom;
        setIsAtBottom(atBottom);
      }
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [checkIfAtBottom]);

  // Auto-scroll on DOM changes — debounced to one scroll per frame.
  // Paused during following mode to avoid fighting with the RAF loop.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scheduleScroll = () => {
      // Don't scroll if user has scrolled up
      if (!isAtBottomRef.current) return;
      // During following, the RAF loop handles scrolling exclusively
      if (followingRef.current) return;
      // Already have a pending scroll for this frame — skip
      if (rafId.current) return;

      rafId.current = requestAnimationFrame(() => {
        rafId.current = 0;
        const c = containerRef.current;
        if (!c || !isAtBottomRef.current) return;
        isProgrammaticScroll.current = true;
        c.scrollTop = c.scrollHeight;
        // Safety: clear the flag next frame if no scroll event fires
        // (e.g., scrollTop didn't actually change because we're already at bottom)
        requestAnimationFrame(() => {
          isProgrammaticScroll.current = false;
        });
      });
    };

    // Watch for size changes (code blocks expanding, images loading, etc.)
    const resizeObserver = new ResizeObserver(scheduleScroll);
    resizeObserver.observe(container);
    for (const child of container.children) {
      resizeObserver.observe(child);
    }

    // Watch for DOM content changes (new text chunks, new elements).
    // Newly added nodes are observed by ResizeObserver; removed nodes are
    // unobserved to prevent the observer set from growing unbounded.
    const mutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLElement) {
            resizeObserver.observe(node);
          }
        }
        for (const node of mutation.removedNodes) {
          if (node instanceof HTMLElement) {
            resizeObserver.unobserve(node);
          }
        }
      }
      scheduleScroll();
    });
    mutationObserver.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => {
      if (rafId.current) cancelAnimationFrame(rafId.current);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
    };
  }, []);

  // RAF loop for frame-perfect scroll following during streaming.
  // Runs every animation frame and directly sets scrollTop = scrollHeight.
  // Because the delta per frame is tiny (just one token's worth of text),
  // the scroll movement is imperceptibly smooth — no visible jumps.
  //
  // User scroll-up detection: each tick compares current scrollTop with
  // the value we last set. If scrollTop decreased AND maxScroll didn't
  // decrease (ruling out content shrink), the user actively scrolled up.
  useEffect(() => {
    if (!following) return;
    let id = 0;
    // Track the scrollTop and maxScroll we last set so we can detect
    // user scroll-up vs content shrink. -1 = first tick, don't compare.
    let lastSetScrollTop = -1;
    let lastMaxScroll = -1;

    const tick = () => {
      const c = containerRef.current;
      if (c && isAtBottomRef.current) {
        const maxScroll = c.scrollHeight - c.clientHeight;

        // Detect user scroll-up: scrollTop decreased, but maxScroll didn't
        // decrease (which would mean content shrank, not user action).
        if (
          lastSetScrollTop >= 0 &&
          c.scrollTop < lastSetScrollTop - 10 &&
          maxScroll >= lastMaxScroll
        ) {
          isAtBottomRef.current = false;
          setIsAtBottom(false);
          lastSetScrollTop = -1;
          lastMaxScroll = -1;
        } else if (maxScroll - c.scrollTop > 0) {
          c.scrollTop = maxScroll;
          lastSetScrollTop = maxScroll;
          lastMaxScroll = maxScroll;
        }
      }
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [following]);

  return {
    containerRef,
    isAtBottom,
    scrollToBottom,
    resetToBottom,
  };
}
