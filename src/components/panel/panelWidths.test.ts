import { describe, it, expect } from 'vitest';
import {
  CHAT_MIN_WIDTH,
  PANEL_GUTTERS,
  SIDEBAR_WIDTH,
  clampNarrowPanelWidth,
} from './panelWidths';

/* The narrow panel's drag used to clamp to its own two constants and nothing
   else, so on a small window it could take the chat column down to ~316px —
   past the point where the composer toolbar has anything left to give up and
   its controls start colliding. CHAT_MIN_WIDTH exists to stop exactly that
   ("fits the composer row"), but only the wide-content drag honored it. */
const MIN_PANEL = 260;
const MAX_PANEL = 560;

function clamp(width: number, viewportWidth: number, sidebarOpen = false): number {
  return clampNarrowPanelWidth(width, viewportWidth, sidebarOpen, MIN_PANEL, MAX_PANEL);
}

function chatColumnFor(panelWidth: number, viewportWidth: number, sidebarOpen = false): number {
  return viewportWidth - panelWidth - PANEL_GUTTERS - (sidebarOpen ? SIDEBAR_WIDTH : 0);
}

describe('clampNarrowPanelWidth', () => {
  it('leaves a roomy window alone — the cap is still the cap', () => {
    expect(clamp(MAX_PANEL, 1400)).toBe(MAX_PANEL);
    expect(clamp(900, 1400)).toBe(MAX_PANEL);
    expect(clamp(400, 1400)).toBe(400);
  });

  it('stops the drag before the chat column drops under its floor', () => {
    // 1000px window, sidebar collapsed: the old clamp allowed 560 and left the
    // chat 416px, which is where the reported two-row composer came from.
    const dragged = clamp(560, 1000);
    expect(dragged).toBeLessThan(560);
    expect(chatColumnFor(dragged, 1000)).toBeGreaterThanOrEqual(CHAT_MIN_WIDTH);
  });

  it('counts the sidebar as space the chat does not have', () => {
    const withoutSidebar = clamp(560, 1200, false);
    const withSidebar = clamp(560, 1200, true);
    expect(withSidebar).toBeLessThan(withoutSidebar);
    expect(chatColumnFor(withSidebar, 1200, true)).toBeGreaterThanOrEqual(CHAT_MIN_WIDTH);
  });

  it('keeps the panel usable when the window cannot satisfy both minimums', () => {
    // 900px (the window minimum) with the sidebar open cannot give the chat 480
    // and the panel 260 at once. The panel yields to its own floor rather than
    // vanishing — the same graceful shrink clampChatWidth performs.
    const dragged = clamp(560, 900, true);
    expect(dragged).toBe(MIN_PANEL);
    expect(chatColumnFor(dragged, 900, true)).toBeLessThan(CHAT_MIN_WIDTH);
  });

  it('never returns less than the panel floor, whatever it is handed', () => {
    for (const viewportWidth of [600, 900, 1000, 1200, 1600]) {
      for (const requested of [-100, 0, 120, 260, 400, 560, 2000]) {
        for (const sidebarOpen of [false, true]) {
          const result = clamp(requested, viewportWidth, sidebarOpen);
          expect(result).toBeGreaterThanOrEqual(MIN_PANEL);
          expect(result).toBeLessThanOrEqual(MAX_PANEL);
        }
      }
    }
  });

  it('gives the space back when the window grows again', () => {
    // Re-clamping at render time is what makes this true: a width dragged wide
    // on a big window must not stay shrunk after a temporary narrow spell.
    const wide = clamp(MAX_PANEL, 1400);
    const squeezed = clamp(wide, 1000);
    const restored = clamp(wide, 1400);
    expect(squeezed).toBeLessThan(wide);
    expect(restored).toBe(MAX_PANEL);
  });
});
