/**
 * Frontend wrapper around the Tauri `secret_*` commands defined in
 * `src-tauri/src/secrets.rs`. Stored values are:
 *   - encrypted with hardware-bound AES-256-GCM on macOS, or
 *   - delegated to OS keyring (Credential Manager / secret-service) on Windows/Linux.
 *
 * Keys follow a colon-namespaced convention:
 *   - `provider:<providerId>` for {@link ProviderInstance.apiKey}
 *   - `aux:webSearch`, `aux:imageGen` for {@link AuxiliaryServices.*.apiKey}
 *   - `imagegen:<backendId>` for {@link ImageGenBackend.apiKey} (independent
 *     image-generation backends, see design doc §3.1 "C-a")
 *
 * All functions are best-effort: errors are returned to callers but never
 * thrown as unhandled rejections. Callers typically fire-and-forget writes
 * since the in-memory state is authoritative during a session.
 */

import { invoke } from '@tauri-apps/api/core';

export const SECRET_KEYS = {
  provider: (id: string) => `provider:${id}`,
  auxWebSearch: 'aux:webSearch',
  auxImageGen: 'aux:imageGen',
  imageGenBackend: (id: string) => `imagegen:${id}`,
} as const;

export async function getSecret(key: string): Promise<string | null> {
  return await invoke<string | null>('secret_get', { key });
}

export async function setSecret(key: string, value: string): Promise<void> {
  await invoke<void>('secret_set', { key, value });
}

export async function deleteSecret(key: string): Promise<void> {
  await invoke<void>('secret_delete', { key });
}

export async function hasSecret(key: string): Promise<boolean> {
  return await invoke<boolean>('secret_has', { key });
}

/**
 * Enumerate all stored keys. macOS returns an array; Windows/Linux returns
 * `null` because the `keyring` crate has no enumeration API. Callers that
 * must work on all platforms should fall back to per-key `hasSecret` probes.
 */
export async function listSecrets(): Promise<string[] | null> {
  return await invoke<string[] | null>('secret_list');
}

/**
 * Keys that could not be decrypted at load time (macOS only). Typically a
 * non-empty list signals a hardware change — IOPlatformUUID rotated so the
 * derived AES key no longer matches the stored ciphertext. The UI surfaces
 * these per-provider so users know their prior keys need re-entering.
 * On Windows/Linux this always returns `[]`.
 */
export async function listFailedSecrets(): Promise<string[]> {
  return await invoke<string[]>('secret_failed_keys');
}

/**
 * Wipe every stored secret. On Windows/Linux the `keyring` crate has no
 * enumeration API, so the caller must pass the full list of keys to remove
 * (the settings UI already knows these from its in-memory provider list).
 * macOS ignores `knownKeys` and truncates the ciphertext file directly.
 */
export async function clearAllSecrets(knownKeys: string[]): Promise<void> {
  await invoke<void>('secret_clear_all', { knownKeys });
}

/**
 * Write-through helper: on empty/missing value, delete the entry instead
 * of storing `""`. Keeps the store clean and matches the "field cleared"
 * semantics the settings UI already uses (empty string = unconfigured).
 */
export async function writeSecretOrDelete(key: string, value: string | undefined): Promise<void> {
  if (value && value.trim().length > 0) {
    await setSecret(key, value);
  } else {
    await deleteSecret(key);
  }
}
