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
    if (!j.serverUrl || !j.accessToken || !j.userId) return null
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
