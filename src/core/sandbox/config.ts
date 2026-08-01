/**
 * Sandbox configuration — determines whether OS-level sandboxing is enabled.
 * On macOS, uses Seatbelt (sandbox-exec) to restrict shell command file access.
 * On Windows, uses PowerShell ConstrainedLanguage mode + ExecutionPolicy Restricted.
 * On other platforms, returns false (no OS-level sandbox available).
 */

import { isMacOS, isWindows } from '@/utils/platform';
import { getSettingsReader } from '@/core/agent/ports/settingsReader';
import { invoke } from '@tauri-apps/api/core';

/** Whether OS-level sandbox should be enabled for shell commands */
export function isSandboxEnabled(): boolean {
  if (!isMacOS() && !isWindows()) return false;
  return getSettingsReader().getSnapshot().sandboxEnabled;
}

/** Whether network isolation (proxy-based domain whitelist) is enabled */
export function isNetworkIsolationEnabled(): boolean {
  if (!isMacOS() && !isWindows()) return false;
  const state = getSettingsReader().getSnapshot();
  return state.sandboxEnabled && state.networkIsolationEnabled;
}

let proxyStarted = false;

/** Start the network proxy if network isolation is enabled. Call once at app init. */
export async function initNetworkProxy(): Promise<void> {
  if (proxyStarted || (!isMacOS() && !isWindows())) return;

  const state = getSettingsReader().getSnapshot();
  if (!state.networkIsolationEnabled) return;

  try {
    const port = await invoke<number>('start_network_proxy', {
      whitelist: state.networkWhitelist,
      allowPrivateNetworks: state.allowPrivateNetworks,
    });
    proxyStarted = true;
    console.log(`[sandbox] Network proxy started on port ${port}`);
  } catch (err) {
    console.error('[sandbox] Failed to start network proxy:', err);
  }
}

/** Sync whitelist changes to the running proxy. */
export async function syncNetworkWhitelist(): Promise<void> {
  if (!proxyStarted) return;
  const state = getSettingsReader().getSnapshot();
  try {
    await invoke('update_network_whitelist', {
      whitelist: state.networkWhitelist,
      allowPrivateNetworks: state.allowPrivateNetworks,
    });
  } catch (err) {
    console.error('[sandbox] Failed to update whitelist:', err);
  }
}
