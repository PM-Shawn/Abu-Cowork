/**
 * Height of the content area of a detail window whose content changes while it
 * is open (a plugin's detail, draft and preview; a connector's detail, logs and
 * catalog entry), so one can replace another without the window changing size.
 * 640px, or what the dialog can show when the app window is short: the dialog
 * is at most the window height minus 96px, and its padding (48), header row
 * (44), the gap under it (16) and the footer (52) take 160 more — 16rem in all.
 * A fixed 640px in a shorter dialog would scroll an empty strip.
 */
export const DETAIL_WINDOW_CONTENT_HEIGHT = 'h-[min(640px,calc(100dvh-16rem))]';
