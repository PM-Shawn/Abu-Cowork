import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '@/stores/settingsStore';
import { parsePetPosition } from './petPositionSync';

/**
 * Show or hide the desktop pet window via its Tauri commands. Returns true if
 * the command succeeded, false if it rejected (logged, not thrown). Callers that
 * persist the "pet open" intent should update it only on a true result, so a
 * failed hide/show is retried later instead of desyncing state from the actual
 * window.
 *
 * Showing passes the saved position (physical px) so the window is created
 * where the user left it, instead of appearing at the default corner and then
 * jumping when the pet restores its position itself.
 */
export async function setPetVisible(open: boolean): Promise<boolean> {
  try {
    if (open) {
      const position = parsePetPosition(useSettingsStore.getState().petPosition);
      await (position ? invoke('pet_show', { position }) : invoke('pet_show'));
    } else {
      await invoke('pet_hide');
    }
    return true;
  } catch (err) {
    console.warn(`[pet] pet_${open ? 'show' : 'hide'} failed:`, err);
    return false;
  }
}

/** Convenience: hide the pet. Returns true on success. */
export function hidePet(): Promise<boolean> {
  return setPetVisible(false);
}
