import type { ReactNode } from 'react';

/**
 * Dumb responsive grid wrapper for the toolbox card grid. Owns no state — the
 * calling section passes already-built <ToolCard> children.
 *
 * Columns use `minmax(240px, 1fr)` so cards STRETCH to fill the row width with
 * no wasted right-hand gap (matching WorkBuddy's even 3-up layout). At the
 * default window size the content column fits three columns, each widened to
 * fill; a wider window reflows to four. 240px is the floor, so cards never get
 * too narrow and a lone item stays a sensible width rather than spanning the row.
 */
export default function ToolGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
      {children}
    </div>
  );
}
