/**
 * Pet → Main window bridge (Phase C).
 *
 * The pet lives in a separate WebView; it can't call chatStore directly.
 * Every interaction that needs main-window state (new conversation, file
 * attach, window focus) is emitted as a Tauri event, and petReceiver on
 * the main side turns it into action.
 */

import { emit } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

export async function emitDropFiles(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await emit('pet-drop-files', { paths });
}

export async function emitMiniSend(text: string, files: string[]): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed && files.length === 0) return;
  await emit('pet-mini-send', { text: trimmed, files });
}

export async function emitFocusMain(): Promise<void> {
  await emit('pet-focus-main');
}

export async function emitOpenSettings(): Promise<void> {
  await emit('pet-open-settings');
}

export async function petResize(width: number, height: number): Promise<void> {
  await invoke('pet_resize', { width, height });
}

export async function petHideSelf(): Promise<void> {
  await invoke('pet_hide');
}

export async function quitApp(): Promise<void> {
  await invoke('app_exit');
}
