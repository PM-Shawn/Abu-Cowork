import { useEffect, useRef, useState, type RefObject } from 'react';

interface FitToWidthResult {
  scale: number;
  scaledWidth: number;
  scaledHeight: number;
}

interface FitToWidthOptions {
  maxScale?: number;
  padding?: number;
}

/**
 * Compute a CSS scale that fits `contentRef`'s natural width into `wrapperRef`.
 *
 * Apply `transform: scale(scale)` + `transform-origin: top left` on the content,
 * and set its parent box `height: scaledHeight` so a surrounding scroller can
 * traverse the visually-scaled multi-page layout.
 */
export function useFitToWidth(
  wrapperRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  options: FitToWidthOptions = {}
): FitToWidthResult {
  const { maxScale = 1, padding = 0 } = options;
  const [scale, setScale] = useState(1);
  const [scaledWidth, setScaledWidth] = useState(0);
  const [scaledHeight, setScaledHeight] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const content = contentRef.current;
    if (!wrapper || !content) return;

    const recompute = () => {
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const available = wrapper.clientWidth - padding * 2;
        const natural = content.scrollWidth;
        if (available <= 0 || natural <= 0) return;
        const next = Math.min(maxScale, available / natural);
        setScale(next);
        setScaledWidth(natural * next);
        setScaledHeight(content.scrollHeight * next);
      });
    };

    const ro = new ResizeObserver(recompute);
    ro.observe(wrapper);
    ro.observe(content);
    recompute();

    return () => {
      ro.disconnect();
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [wrapperRef, contentRef, maxScale, padding]);

  return { scale, scaledWidth, scaledHeight };
}
