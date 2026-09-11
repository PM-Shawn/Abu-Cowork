import { useEffect, useRef, type ReactNode } from 'react';

// Only height changes bigger than this animate. Streamed tokens grow content a
// line (~20px) at a time and must stay instant — animating them would make the
// text feel like it's lagging behind the stream. The threshold targets layout
// *swaps*: the work-process fold replacing an expanded thinking/step block at
// completion (-100~200px), or the user toggling that fold open.
const THRESHOLD_PX = 40;
// Matches claude.ai's collapsible-block transition duration (280ms ease-out),
// which our expand-on-mount animation (.block-expand-enter, 200ms) sits just
// under — swaps read slightly slower than streaming growth, deliberately.
const DURATION_MS = 280;

/**
 * Smooths abrupt height changes of its children: when the content's natural
 * height jumps by more than THRESHOLD_PX in one layout pass, the wrapper pins
 * its height and transitions to the new value instead of letting it land in a
 * single frame.
 *
 * Why this exists: with the chat pinned to the bottom, a one-frame shrink of
 * the last message group (the completion fold replacing the expanded thinking
 * block) clamps scrollTop instantly — the whole view visibly jumps DOWN. The
 * mount direction is covered by .block-expand-enter, but the fold is a
 * component *swap* (TaskBlock unmounts, the "用时 Xs" header mounts), so no
 * CSS enter/exit animation on either component can bridge it. Animating the
 * measured height of the region that contains the swap can.
 *
 * Non-goals / guarantees:
 * - First measure after mount never animates — history rows remounting during
 *   virtualized scrolling must not dance.
 * - Small (≤ threshold) changes are untouched: height stays `auto`, streaming
 *   text follows instantly.
 * - Honors prefers-reduced-motion; no-ops entirely without ResizeObserver
 *   (jsdom).
 */
export default function SmoothHeight({
  children,
  enabled = true,
}: {
  children: ReactNode;
  /**
   * When false the wrapper renders but observes nothing — height changes are
   * instant. Callers that render many instances (one per virtualized message
   * group) disable all but the one that can actually swap (the live group);
   * keeping the wrapper elements mounted either way means toggling `enabled`
   * never restructures the DOM (which would remount children and reset their
   * state, e.g. iframe widgets).
   */
  enabled?: boolean;
}) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const lastHeightRef = useRef<number | null>(null);
  const animatingRef = useRef(false);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!enabled) return;
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner || typeof ResizeObserver === 'undefined') return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

    const settle = () => {
      animatingRef.current = false;
      outer.style.height = '';
      outer.style.overflow = '';
      outer.style.transition = '';
    };

    const ro = new ResizeObserver((entries) => {
      const newHeight =
        entries[entries.length - 1]?.contentRect.height ?? inner.offsetHeight;
      const prev = lastHeightRef.current;
      lastHeightRef.current = newHeight;
      // First measure = mount; never animate (virtualized remounts of old rows).
      if (prev == null) return;
      if (reduceMotion?.matches) return;
      // While an animation is in flight every change retargets it (the content
      // may still be settling); otherwise only large jumps start one.
      if (!animatingRef.current && Math.abs(newHeight - prev) <= THRESHOLD_PX) return;

      // FLIP: pin the height the box had BEFORE this mutation, then transition
      // to the new natural height. ResizeObserver fires after layout, so on a
      // fresh trigger the auto-height outer has ALREADY snapped to the new
      // size — measuring it here would return ≈newHeight and the epsilon check
      // below would cancel the animation every time (jsdom's all-zero rects
      // hid this from the unit tests). `prev` is the last recorded height,
      // i.e. what the user was actually seeing. Mid-flight retargets DO
      // measure: an explicit pinned height + transition is in effect, so the
      // rect reflects the true in-between position to resume from.
      const startHeight = animatingRef.current
        ? outer.getBoundingClientRect().height
        : prev;
      if (Math.abs(startHeight - newHeight) < 1) {
        settle();
        return;
      }
      animatingRef.current = true;
      outer.style.transition = 'none';
      outer.style.height = `${startHeight}px`;
      // Clip while pinned smaller than the content (grow direction).
      outer.style.overflow = 'hidden';
      // Commit the start height before enabling the transition, or the browser
      // coalesces both writes and nothing animates.
      void outer.offsetHeight;
      outer.style.transition = `height ${DURATION_MS}ms ease-out`;
      outer.style.height = `${newHeight}px`;
      // Timer instead of transitionend: 'transitionend' is swallowed when the
      // transition is retargeted or the element is display-toggled mid-flight,
      // which would leave the height pinned forever.
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = setTimeout(settle, DURATION_MS + 50);
    });
    ro.observe(inner);
    return () => {
      ro.disconnect();
      clearTimeout(settleTimerRef.current);
      settle();
      // Re-enabling later must not animate the first measure it sees.
      lastHeightRef.current = null;
    };
  }, [enabled]);

  return (
    <div ref={outerRef}>
      <div ref={innerRef}>{children}</div>
    </div>
  );
}
