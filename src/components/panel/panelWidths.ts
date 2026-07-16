// Shared layout widths for the chat + preview split (TRAE-style model).
//
// When a file preview is open, the CHAT column takes a stable width and the
// PREVIEW column flex-fills the rest. Opening the sidebar shrinks the *preview*,
// not the chat — so neither the 2-column nor the 3-column layout ever crushes the
// chat. See RightPanel.tsx (preview = flex-1) and App.tsx (chat = explicit width).
//
// The chat default is a fraction of the window so the preview stays the big "main
// stage" (~60%, matching Trae) on any monitor, bounded so the chat stays readable.

import { useEffect, useState } from 'react';

export const SIDEBAR_WIDTH = 260;        // Must match App.tsx sidebar fixed width
export const CHAT_RATIO = 0.40;          // Chat ≈ 40% of the window → preview ≈ 60%
export const CHAT_MIN_WIDTH = 480;       // Chat never narrower than this (fits the composer row)
export const CHAT_MAX_WIDTH = 820;       // Upper bound so the preview keeps the majority
export const PREVIEW_MIN_WIDTH = 380;    // Preview column keeps at least this much (shrinks gracefully on narrow windows, TRAE-style)
// Total horizontal space the floating card gutters consume (sidebar↔chat 8 +
// chat↔preview 8 + preview↔window-edge 8). Must match the ml/mr margins on the
// chat card (App.tsx) and the preview card (RightPanel.tsx). Reserved here so the
// chat/preview widths never sum past the viewport and clip the right card.
export const PANEL_GUTTERS = 24;

export function getViewportWidth(): number {
  return typeof window !== 'undefined' ? window.innerWidth : 1440;
}

// Largest chat width that still leaves the preview its minimum. Prefers [CHAT_MIN, CHAT_MAX],
// but hard-caps at the room the preview leaves so the 3-column layout never overflows the
// viewport. On a window too narrow to give both their comfortable minimums it returns a value
// below CHAT_MIN_WIDTH — a narrow chat beats a clipped preview (TRAE-style graceful shrink).
function maxChatWidth(viewportWidth: number, sidebarOpen: boolean): number {
  const available = viewportWidth - (sidebarOpen ? SIDEBAR_WIDTH : 0) - PANEL_GUTTERS;
  const roomForChat = available - PREVIEW_MIN_WIDTH;
  return Math.min(CHAT_MAX_WIDTH, Math.max(CHAT_MIN_WIDTH, roomForChat), roomForChat);
}

// Clamp a chat width into [floor, maxChatWidth]. The floor is normally CHAT_MIN_WIDTH, but
// yields to maxChatWidth when the window is too narrow (so the total never overflows/clips).
export function clampChatWidth(width: number, viewportWidth: number, sidebarOpen: boolean): number {
  const max = maxChatWidth(viewportWidth, sidebarOpen);
  return Math.min(Math.max(width, Math.min(CHAT_MIN_WIDTH, max)), max);
}

// Resolve the on-screen chat width: the user's dragged value (if any) falls back to
// the window-proportional default, then is clamped to the viewport + sidebar state.
// Computed at render time so it restores toward the default when space frees up
// (e.g. the sidebar collapses) instead of staying stuck at an earlier shrunk value.
export function resolveChatWidth(chatWidth: number | null, viewportWidth: number, sidebarOpen: boolean): number {
  const preferred = chatWidth ?? Math.round(viewportWidth * CHAT_RATIO);
  return clampChatWidth(preferred, viewportWidth, sidebarOpen);
}

// Reactive window.innerWidth so the layout re-clamps on resize.
export function useViewportWidth(): number {
  const [width, setWidth] = useState<number>(getViewportWidth);
  useEffect(() => {
    const onResize = () => setWidth(getViewportWidth());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}
