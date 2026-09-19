import { invoke } from '@tauri-apps/api/core';

export interface AccountAuthCallback {
  code: string;
  state: string;
}

export type AccountProtocolRegistrationStatus = 'registered' | 'not_registered' | 'unknown';

/** Query whether this exact Electron shell owns its current dev/prod scheme. */
export async function getAccountProtocolRegistrationStatus(): Promise<AccountProtocolRegistrationStatus> {
  try {
    const registered = await invoke<unknown>('plugin:deep-link|is_registered');
    if (registered === true) return 'registered';
    if (registered === false) return 'not_registered';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export function isAccountAuthDeepLink(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'abu:' && url.hostname === 'auth';
  } catch {
    return false;
  }
}

/** Parse only the canonical renderer-facing auth callback shape. */
export function parseAccountAuthCallback(raw: string): AccountAuthCallback | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    !isAccountAuthDeepLink(raw) ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== '' ||
    url.hash
  ) return null;
  const codes = url.searchParams.getAll('code');
  const states = url.searchParams.getAll('state');
  if (codes.length !== 1 || states.length !== 1 || !codes[0] || !states[0]) return null;
  return { code: codes[0], state: states[0] };
}
