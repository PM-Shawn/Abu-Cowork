import type { ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * Tooltip for a button in the browser pane's OWN toolbar (back/forward/
 * reload/open-external/inspect) — the row directly above the native browser
 * webview. That webview paints OVER React regardless of CSS z-index, and a
 * default `side="bottom"` tooltip's content dips a few pixels past this
 * toolbar's bottom edge, so it gets visually clipped by whatever page is
 * loaded underneath.
 *
 * Rendering upward instead (`side="top"`) keeps the tooltip entirely within
 * DOM-only space (the tab strip above), so it never touches the native
 * view's rect. An earlier version of this fix instead force-hid the native
 * webview whenever a tooltip was open (mirroring how `menuOpen` hides it for
 * click-triggered popovers) — that caused a visible flash on every hover,
 * since tooltips (unlike rare menu opens) fire constantly as the pointer
 * crosses the toolbar. Geometric avoidance has no such cost.
 *
 * Only use this for buttons in the browser pane's own toolbar row — nothing
 * else in the app sits directly above the native view.
 */
export function ToolbarTooltip({ children, content }: { children: ReactNode; content: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top">{content}</TooltipContent>
    </Tooltip>
  );
}
