/**
 * Who stores the desktop pet's position: the MAIN window.
 *
 * The pet window and the main window each load their own in-memory copy of
 * the persisted `abu-settings` store (same origin, same localStorage), and
 * zustand's persist middleware rewrites the whole entry on every `set()`. So a
 * position the pet saved itself was overwritten by the main window's stale
 * copy on its next settings write — opening Settings was enough — and the pet
 * reopened at the default corner. (The pet's own write also put back ITS stale
 * copy of every other setting.) The pet therefore only announces where it was
 * left; the main window validates and stores it, the same split as
 * `pet-open-state-changed`.
 *
 * Units: physical pixels, as `outerPosition()` / `onMoved` report and
 * `setPosition(new PhysicalPosition(...))` / `pet_show { position }` consume.
 */

/** Pet → main window: `{ x, y }` in physical pixels. */
export const PET_POSITION_EVENT = 'pet-position-changed';

export interface PetPosition {
  x: number;
  y: number;
}

/** Same bound the host's placement check uses (electron/windowPlacement.cjs). */
const MAX_ABS_COORD = 1_000_000;

/** A finite, in-bounds `{ x, y }` from an event payload or a persisted value, else null. */
export function parsePetPosition(value: unknown): PetPosition | null {
  if (!value || typeof value !== 'object') return null;
  const { x, y } = value as Record<string, unknown>;
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (Math.abs(x) > MAX_ABS_COORD || Math.abs(y) > MAX_ABS_COORD) return null;
  return { x, y };
}
