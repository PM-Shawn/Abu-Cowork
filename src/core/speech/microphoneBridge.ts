/**
 * Renderer access to the OS microphone consent (electron/microphonePermissions.cjs).
 * Capture itself is plain getUserMedia; this bridge only reports the OS status
 * and opens the platform's microphone privacy page for recovery guidance.
 */

export type MicrophoneStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';

type MicrophoneBridge = (action: 'status' | 'open-settings') => Promise<unknown>;

function bridge(): MicrophoneBridge | undefined {
  return (globalThis as typeof globalThis & { __ABU_SHELL__?: { microphone?: MicrophoneBridge } })
    .__ABU_SHELL__?.microphone;
}

const STATUSES = new Set<MicrophoneStatus>(['not-determined', 'granted', 'denied', 'restricted', 'unknown']);

/** OS microphone consent; `unknown` outside the Electron host. */
export async function getMicrophoneStatus(): Promise<MicrophoneStatus> {
  const host = bridge();
  if (!host) return 'unknown';
  const status = await host('status');
  return typeof status === 'string' && STATUSES.has(status as MicrophoneStatus)
    ? status as MicrophoneStatus
    : 'unknown';
}

/** Open the OS microphone privacy page; false when the platform has none. */
export async function openMicrophoneSettings(): Promise<boolean> {
  const host = bridge();
  if (!host) return false;
  return (await host('open-settings')) === true;
}
