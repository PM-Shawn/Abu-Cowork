import { invoke } from '@tauri-apps/api/core';

/**
 * Show or hide the desktop pet window via its Tauri commands. Returns true if
 * the command succeeded, false if it rejected (logged, not thrown). Callers that
 * persist the "pet open" intent should update it only on a true result, so a
 * failed hide/show is retried later instead of desyncing state from the actual
 * window.
 */
export async function setPetVisible(open: boolean): Promise<boolean> {
  try {
    await invoke(open ? 'pet_show' : 'pet_hide');
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
