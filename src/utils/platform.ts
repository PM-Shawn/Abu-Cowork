/**
 * Platform Detection Singleton
 * Provides synchronous platform checks after async initialization.
 */

import { platform } from '@tauri-apps/plugin-os';

let cached: string | null = null;

/** Initialize platform detection (call once at app startup) */
export async function initPlatform(): Promise<string> {
  cached = await platform();
  return cached;
}

/** Returns true if running on Windows */
export function isWindows(): boolean {
  return cached === 'windows';
}

/** Returns true if running on macOS */
export function isMacOS(): boolean {
  return cached === 'macos';
}

/** Get the cached platform string. Warns if called before initPlatform(). */
export function getPlatform(): string {
  if (cached === null) {
    console.warn('[platform] getPlatform() called before initPlatform() — defaulting to "unknown"');
  }
  return cached ?? 'unknown';
}

/** Get the default shell for the current platform. */
export function getShell(): string {
  if (cached === 'windows') return 'PowerShell';
  return 'zsh/bash';
}
