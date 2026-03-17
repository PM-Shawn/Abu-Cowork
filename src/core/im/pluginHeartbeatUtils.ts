/**
 * PluginHeartbeatUtils — Helper to get trigger server port for heartbeat registration
 */

import { invoke } from '@tauri-apps/api/core';

/**
 * Get the trigger server port from Rust side.
 */
export async function get_trigger_port(): Promise<number | null> {
  try {
    const port = await invoke<number | null>('get_trigger_server_port');
    return port ?? null;
  } catch {
    return null;
  }
}
