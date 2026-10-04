import { invoke } from '@tauri-apps/api/core';
import { hasElectronCommandHost } from '@/utils/electronHost';

/**
 * Renderer view of the Host-owned Computer Use grant store (L2 §2.4).
 * The Host Gate is the only writer; this module reads the `list()`
 * projection (no signer subject) and forwards revoke / deny decisions.
 */

export type ComputerUseGrantTier = 'ordinary' | 'approval-required';

export interface ComputerUseGrantRecord {
  key: string;
  displayName: string;
  tier: ComputerUseGrantTier;
  grantedAt: number;
  lastUsedAt: number;
  source: 'dialog' | 'settings';
}

export interface ComputerUseDeniedRecord {
  key: string;
  displayName: string;
  deniedAt: number;
}

export interface ComputerUseGrantList {
  /** False when no Host grant store answers (non-Electron runtime or store unavailable). */
  available: boolean;
  grants: ComputerUseGrantRecord[];
  denied: ComputerUseDeniedRecord[];
}

const EMPTY_GRANT_LIST: ComputerUseGrantList = { available: false, grants: [], denied: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseGrant(value: unknown): ComputerUseGrantRecord | null {
  if (
    !isRecord(value)
    || typeof value.key !== 'string' || !value.key
    || typeof value.displayName !== 'string'
    || (value.tier !== 'ordinary' && value.tier !== 'approval-required')
    || typeof value.grantedAt !== 'number' || !Number.isFinite(value.grantedAt)
    || typeof value.lastUsedAt !== 'number' || !Number.isFinite(value.lastUsedAt)
  ) {
    return null;
  }
  return {
    key: value.key,
    displayName: value.displayName || value.key,
    tier: value.tier,
    grantedAt: value.grantedAt,
    lastUsedAt: value.lastUsedAt,
    source: value.source === 'settings' ? 'settings' : 'dialog',
  };
}

function parseDenied(value: unknown): ComputerUseDeniedRecord | null {
  if (
    !isRecord(value)
    || typeof value.key !== 'string' || !value.key
    || typeof value.displayName !== 'string'
    || typeof value.deniedAt !== 'number' || !Number.isFinite(value.deniedAt)
  ) {
    return null;
  }
  return { key: value.key, displayName: value.displayName || value.key, deniedAt: value.deniedAt };
}

export function parseComputerUseGrantList(value: unknown): ComputerUseGrantList {
  if (!isRecord(value) || value.available !== true) return EMPTY_GRANT_LIST;
  const grants = Array.isArray(value.grants) ? value.grants : [];
  const denied = Array.isArray(value.denied) ? value.denied : [];
  return {
    available: true,
    grants: grants.map(parseGrant).filter((record): record is ComputerUseGrantRecord => record !== null),
    denied: denied.map(parseDenied).filter((record): record is ComputerUseDeniedRecord => record !== null),
  };
}

export async function listComputerUseGrants(): Promise<ComputerUseGrantList> {
  if (!hasElectronCommandHost()) return EMPTY_GRANT_LIST;
  return parseComputerUseGrantList(await invoke<unknown>('computer_use_list_grants', {}));
}

/** Forget an "always allow" record; the next task asks again. */
export async function revokeComputerUseGrant(key: string): Promise<boolean> {
  if (!hasElectronCommandHost()) return false;
  const result = await invoke<unknown>('computer_use_revoke_grant', { key });
  return isRecord(result) && result.revoked === true;
}

/** Put an app on the user's denied list (also revokes it) or take it off again. */
export async function setComputerUseAppDenied(
  key: string,
  denied: boolean,
  displayName?: string,
): Promise<void> {
  if (!hasElectronCommandHost()) return;
  await invoke<unknown>('computer_use_set_denied', {
    key,
    denied,
    ...(displayName ? { displayName } : {}),
  });
}
