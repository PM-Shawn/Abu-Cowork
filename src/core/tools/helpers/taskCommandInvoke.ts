import { invoke } from '@tauri-apps/api/core';

export type TaskCommandInvoke = <T>(
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<T>;

/**
 * Capture the native command dispatcher used by one task command.
 *
 * The renderer has no ambient run ownership, so its dispatcher is simply the
 * normal Tauri-shaped invoke function. The sidecar bundle redirects this
 * module to a Node-only implementation that binds the owning run context at
 * command registration time, before an out-of-band abort can lose it.
 */
export function captureTaskCommandInvoke(_runIdHint?: string): TaskCommandInvoke {
  return invoke;
}
