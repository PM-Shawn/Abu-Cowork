/**
 * Decide what to do with the desktop pet window at app startup, given the pet
 * Labs unlock flag and the persisted `petOpen` intent.
 * - unlocked + open → 'show'; locked + open → 'hide' (stale intent); else 'none'.
 * Pure so it is unit-testable without a Tauri runtime.
 */
export function resolvePetBootAction(
  petUnlocked: boolean,
  petOpen: boolean,
): 'show' | 'hide' | 'none' {
  if (petUnlocked) return petOpen ? 'show' : 'none';
  return petOpen ? 'hide' : 'none';
}
