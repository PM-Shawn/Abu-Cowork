/**
 * Notice GateContext provider — assembles real runtime state.
 *
 * Reads window focus from Tauri, current conversation from chatStore,
 * fullscreen from Rust command. Pet state is always 'off' until
 * desktop pet ships (PRD-02).
 *
 * The provider caches fullscreen state with a 5s TTL to avoid
 * shelling out to osascript on every publish.
 */

import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { useChatStore } from '@/stores/chatStore';
import type { GateContext } from './gate';

const FULLSCREEN_CACHE_TTL_MS = 30_000;

let cachedFullscreenApp: string | null = null;
let fullscreenCacheExpiry = 0;

async function getFullscreenApp(now: number): Promise<string | null> {
  if (now < fullscreenCacheExpiry) return cachedFullscreenApp;

  try {
    const info = await invoke<{ is_fullscreen: boolean; app_name: string | null }>(
      'check_fullscreen',
    );
    cachedFullscreenApp = info.is_fullscreen ? (info.app_name ?? 'unknown') : null;
  } catch {
    cachedFullscreenApp = null;
  }
  fullscreenCacheExpiry = now + FULLSCREEN_CACHE_TTL_MS;
  return cachedFullscreenApp;
}

let cachedFocused = true;
let focusCacheExpiry = 0;
const FOCUS_CACHE_TTL_MS = 1_000;

async function getWindowFocused(now: number): Promise<boolean> {
  if (now < focusCacheExpiry) return cachedFocused;

  try {
    cachedFocused = await getCurrentWindow().isFocused();
  } catch {
    cachedFocused = true;
  }
  focusCacheExpiry = now + FOCUS_CACHE_TTL_MS;
  return cachedFocused;
}

/**
 * Assemble GateContext from real runtime state.
 *
 * This is async because it reads Tauri window focus and fullscreen.
 * The pipeline's synchronous contextProvider uses the cached values
 * (always populated after the first call).
 */
export async function assembleGateContext(now: number): Promise<GateContext> {
  const [focused, fullscreenApp] = await Promise.all([
    getWindowFocused(now),
    getFullscreenApp(now),
  ]);

  const chatState = useChatStore.getState();

  return {
    now,
    mainWindowFocused: focused,
    currentConversationId: chatState.activeConversationId,
    petState: 'off',
    fullscreenApp,
    recentL2Count: { windowStart: 0, count: 0 },
    userFeedbackHistory: [],
  };
}

/**
 * Synchronous context provider for the pipeline.
 * Uses cached values from the last async assembly.
 * Suitable for the pipeline's synchronous processNotice call.
 */
export function cachedContextProvider(now: number): GateContext {
  const chatState = useChatStore.getState();

  return {
    now,
    mainWindowFocused: cachedFocused,
    currentConversationId: chatState.activeConversationId,
    petState: 'off',
    fullscreenApp: cachedFullscreenApp,
    recentL2Count: { windowStart: 0, count: 0 },
    userFeedbackHistory: [],
  };
}

/**
 * Prime the caches so the first synchronous call has real data.
 * Call once at app startup.
 */
export async function primeContextCaches(): Promise<void> {
  const now = Date.now();
  await Promise.all([getWindowFocused(now), getFullscreenApp(now)]);
}
