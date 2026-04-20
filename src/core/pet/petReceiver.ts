/**
 * Pet → Main receiver (Phase C).
 *
 * Listens to events emitted by the pet window (petBridge.ts) and drives
 * main-window side effects: focus main, start new conversation, pre-fill
 * input, open settings.
 */

import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { setPendingAttachments } from './pendingAttachments';

interface DropFilesPayload {
  paths: string[];
}

interface MiniSendPayload {
  text: string;
  files: string[];
}

async function focusMainWindow(): Promise<void> {
  // This code runs in the main window's WebView, so getCurrentWindow()
  // is the main window handle. show + unminimize + setFocus matches the
  // Rust-side show_main_window helper (used by tray clicks).
  const win = getCurrentWindow();
  try {
    await win.show();
    await win.unminimize();
    await win.setFocus();
  } catch {
    // Non-critical.
  }
}

async function handleDropFiles(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await focusMainWindow();
  useChatStore.getState().startNewConversation();
  useSettingsStore.getState().setViewMode('chat');
  setPendingAttachments(paths);
}

async function handleMiniSend(text: string, files: string[]): Promise<void> {
  await focusMainWindow();
  useChatStore.getState().startNewConversation();
  useSettingsStore.getState().setViewMode('chat');
  if (files.length > 0) setPendingAttachments(files);
  if (text) useChatStore.getState().setPendingInput(text);
}

async function handleFocusMain(): Promise<void> {
  await focusMainWindow();
}

async function handleOpenSettings(): Promise<void> {
  await focusMainWindow();
  useSettingsStore.getState().openSystemSettings();
}

let started = false;
const unlistens: Array<() => void> = [];

export async function startPetReceiver(): Promise<void> {
  if (started) return;
  started = true;

  unlistens.push(
    await listen<DropFilesPayload>('pet-drop-files', ({ payload }) => {
      void handleDropFiles(payload.paths ?? []);
    }),
  );
  unlistens.push(
    await listen<MiniSendPayload>('pet-mini-send', ({ payload }) => {
      void handleMiniSend(payload.text ?? '', payload.files ?? []);
    }),
  );
  unlistens.push(
    await listen('pet-focus-main', () => {
      void handleFocusMain();
    }),
  );
  unlistens.push(
    await listen('pet-open-settings', () => {
      void handleOpenSettings();
    }),
  );
}

export function stopPetReceiver(): void {
  started = false;
  unlistens.forEach((fn) => fn());
  unlistens.length = 0;
}
