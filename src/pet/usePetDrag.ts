/**
 * Pet drag + edge snap (Phase B).
 *
 * Tauri's `startDragging()` transfers the mouse drag to the native window
 * manager, so we don't see mousemove/mouseup on the DOM side once it's
 * engaged. We rely on `onMoved` events to know where the window ended up,
 * then debounce the tail move to persist position + apply edge snap.
 *
 * `startDragging()` is only invoked after the pointer moves past
 * `DRAG_THRESHOLD_PX` from mousedown — calling it unconditionally on every
 * mousedown (including a plain click with no movement) briefly engages the
 * native window drag session and causes a visible flicker. Gating on a
 * movement threshold, like a normal click/drag disambiguation, avoids that
 * for plain clicks and lets us flag `consumeDrag()` so the click handler can
 * suppress the synthetic `click` DOM event WebKit still fires after a real
 * drag-release (mousedown + mouseup on the same element always fires click,
 * even when startDragging() consumed the movement in between).
 *
 * Edge snap: when the pet stops within 20px of a screen edge, we snap
 * it to hide 40% of its body off-screen (PRD-02 "docked" feel).
 *
 * Position persistence: settingsStore (Zustand persist). On first use,
 * migrates any legacy value from localStorage ('abu-pet-position') and
 * removes the old key.
 */

import { useEffect, useRef } from 'react';
import { getCurrentWindow, primaryMonitor, PhysicalPosition } from '@tauri-apps/api/window';
import { useSettingsStore } from '@/stores/settingsStore';

const STORAGE_KEY = 'abu-pet-position';
const SNAP_THRESHOLD = 20;
const HIDE_RATIO = 0.4;
const DEBOUNCE_MS = 220;
const PET_SIZE = 80;
// A plain trackpad/mouse click naturally jitters a few pixels between
// mousedown and mouseup — 4px was tight enough that ordinary clicks tripped
// the drag threshold (startDragging() briefly engaging = the flicker, and
// consumeDrag() then swallowing the click that should have opened the
// bubble). 10px gives clicks enough headroom while still catching
// intentional small drags quickly.
const DRAG_THRESHOLD_PX = 10;

interface Stored {
  x: number;
  y: number;
}

function loadStored(): Stored | null {
  // Read from settingsStore; migrate from localStorage on first use.
  const stored = useSettingsStore.getState().petPosition;
  if (stored) return stored;

  const legacy = localStorage.getItem(STORAGE_KEY);
  if (legacy) {
    try {
      const parsed = JSON.parse(legacy) as Stored;
      if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
        useSettingsStore.getState().setPetPosition(parsed);
        localStorage.removeItem(STORAGE_KEY);
        return parsed;
      }
    } catch { /* ignore malformed */ }
  }
  return null;
}

function saveStored(pos: Stored): void {
  useSettingsStore.getState().setPetPosition(pos);
}

async function resolveSnap(x: number, y: number): Promise<Stored> {
  const monitor = await primaryMonitor();
  if (!monitor) return { x, y };

  // Monitor size is physical; getCurrentWindow positions are physical too.
  const { width: screenW, height: screenH } = monitor.size;
  const scale = monitor.scaleFactor ?? 1;
  const petPhysical = PET_SIZE * scale;
  const snapPhysical = SNAP_THRESHOLD * scale;
  const hidePhysical = Math.round(petPhysical * HIDE_RATIO);

  let snapX = x;
  let snapY = y;

  // Left edge
  if (x < snapPhysical) {
    snapX = -hidePhysical;
  }
  // Right edge
  if (x + petPhysical > screenW - snapPhysical) {
    snapX = screenW - petPhysical + hidePhysical;
  }
  // Clamp vertical to stay on-screen
  if (y < 0) snapY = 0;
  if (y + petPhysical > screenH) snapY = Math.max(0, screenH - petPhysical);

  return { x: snapX, y: snapY };
}

/**
 * Wire up drag-to-move + edge-snap + position-persist on the pet window.
 *
 * Returns a ref that callers bind to the draggable surface (`<div ref={...}>`)
 * plus `consumeDrag()`, which returns true (and resets) if a real drag just
 * happened — callers should use it to suppress the click that follows a
 * drag-release.
 */
export function usePetDrag<T extends HTMLElement>(): {
  ref: React.RefObject<T | null>;
  consumeDrag: () => boolean;
} {
  const ref = useRef<T | null>(null);
  const draggedRef = useRef(false);

  // Restore last position once at mount.
  useEffect(() => {
    const stored = loadStored();
    if (!stored) return;
    getCurrentWindow()
      .setPosition(new PhysicalPosition(stored.x, stored.y))
      .catch(() => {});
  }, []);

  // Mousedown → wait for real movement past a threshold before engaging
  // Tauri's native startDragging(). Calling it unconditionally on every
  // mousedown (even a plain click) briefly enters a native drag session
  // and visibly flickers.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onMouseDown = (e: MouseEvent) => {
      // Left button only; right-click reserved for menu (Phase C).
      if (e.button !== 0) return;
      // A fresh press always starts clean. If a previous drag ended without
      // WebKit delivering the synthetic click (so consumeDrag() never ran),
      // the stale flag would otherwise swallow the NEXT genuine click —
      // "click does nothing" / click misread as a drag.
      draggedRef.current = false;
      const startX = e.screenX;
      const startY = e.screenY;
      let dragStarted = false;

      const cleanup = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };

      const onMouseMove = (moveEvent: MouseEvent) => {
        if (dragStarted) return;
        const dx = moveEvent.screenX - startX;
        const dy = moveEvent.screenY - startY;
        if (Math.abs(dx) >= DRAG_THRESHOLD_PX || Math.abs(dy) >= DRAG_THRESHOLD_PX) {
          dragStarted = true;
          draggedRef.current = true;
          getCurrentWindow().startDragging().catch(() => {});
          cleanup();
        }
      };

      const onMouseUp = () => {
        cleanup();
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    };

    el.addEventListener('mousedown', onMouseDown);
    return () => el.removeEventListener('mousedown', onMouseDown);
  }, []);

  // onMoved → debounce → snap + persist.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    let timer: number | null = null;

    getCurrentWindow()
      .onMoved(({ payload }) => {
        if (timer !== null) clearTimeout(timer);
        timer = window.setTimeout(async () => {
          // `ref` is only attached while the pet is collapsed (PetApp passes
          // `ref={isDraggable ? dragRef : undefined}`), so `ref.current` is
          // null while the bubble/menu is open. Programmatic frame changes
          // during expand/collapse also fire onMoved (macOS reports a move
          // whenever the Cocoa bottom-left origin shifts, which happens on a
          // plain top-anchored resize too) — running the snap math then would
          // yank the expanded window (it assumes the 80x80 collapsed size)
          // and persist a transient position. Skip unless collapsed.
          if (!ref.current) return;
          const snapped = await resolveSnap(payload.x, payload.y);
          if (snapped.x !== payload.x || snapped.y !== payload.y) {
            getCurrentWindow()
              .setPosition(new PhysicalPosition(snapped.x, snapped.y))
              .catch(() => {});
          }
          saveStored(snapped);
        }, DEBOUNCE_MS);
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      unlisten?.();
    };
  }, []);

  const consumeDrag = () => {
    const was = draggedRef.current;
    draggedRef.current = false;
    return was;
  };

  return { ref, consumeDrag };
}
