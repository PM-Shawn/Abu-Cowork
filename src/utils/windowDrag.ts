import { isMacOS } from '@/utils/platform';

/**
 * Opt a card's own header row into the window drag lane — macOS only.
 *
 * Windows and Linux draw their own chrome rows above the content cards, each
 * with an explicit empty drag lane (see `WindowTitleBar`). macOS has no such
 * row: `titleBarStyle: 'hidden'` leaves the card starting 8px below the window
 * top, so the band beside the traffic lights *is* the card, and the card is
 * `data-electron-no-drag`. The result was that only the top 8px of the window
 * could ever move it.
 *
 * Marking a header row with `data-electron-drag` re-opens the lane there. The
 * stylesheet keeps every child of that row no-drag, so titles stay
 * double-clickable and buttons stay clickable without per-element marking.
 *
 * Spread it onto the row element: `<div {...windowDragRowProps()} className=…>`
 */
export function windowDragRowProps(): Record<string, string> {
  return isMacOS() ? { 'data-electron-drag': '' } : {};
}
