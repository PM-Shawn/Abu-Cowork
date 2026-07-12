// src/core/enterprise/boot.ts
// Reads AppData/enterprise/binding.json at startup.
import { exists, readTextFile, writeTextFile, remove, BaseDirectory } from '@tauri-apps/plugin-fs'
import type { EnterpriseBinding } from './types'

const PATH = 'enterprise/binding.json'

export async function loadBinding(): Promise<EnterpriseBinding | null> {
  if (!await exists(PATH, { baseDir: BaseDirectory.AppData })) return null
  const raw = await readTextFile(PATH, { baseDir: BaseDirectory.AppData })
  try {
    const j = JSON.parse(raw) as EnterpriseBinding
    // Minimum required fields — applies to both new (access+refresh pair) and
    // legacy (90d single-token) formats.
    if (!j.serverUrl || !j.accessToken || !j.userId) return null
    // Migration note: legacy bindings (no refreshToken / no accessExpiresAt) are
    // loaded as-is.  Auto-refresh is silently disabled for them; they work until
    // the long-lived token expires at which point the user must re-bind.
    return j
  } catch { return null }
}

export async function saveBinding(b: EnterpriseBinding): Promise<void> {
  await writeTextFile(PATH, JSON.stringify(b, null, 2), { baseDir: BaseDirectory.AppData })
}

export async function clearBinding(): Promise<void> {
  if (await exists(PATH, { baseDir: BaseDirectory.AppData })) {
    await remove(PATH, { baseDir: BaseDirectory.AppData })
  }
}
